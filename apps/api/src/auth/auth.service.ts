import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DeviceStatus, Prisma, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../common/contracts';
import { AuditService } from '../common/audit.service';
import type { LoginDeviceDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, device?: LoginDeviceDto) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !(await argon2.verify(user.passwordHash, password))
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        detail: '用户名或密码错误',
      });
    }

    if (user.role === Role.AGENT) {
      if (!device) {
        throw new UnauthorizedException({
          code: 'DEVICE_DETAILS_REQUIRED',
          detail: '坐席账号必须使用安卓 APP 登录',
        });
      }
      return this.loginAgent(user, device);
    }
    if (device) {
      throw new UnauthorizedException({
        code: 'AGENT_ACCOUNT_REQUIRED',
        detail: '安卓 APP 只允许坐席账号登录',
      });
    }

    const tokens = await this.issueTokens(user.id, user.role, user.tokenVersion);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: user.id,
    });
    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.displayName,
        displayName: user.displayName,
        role: user.role,
        enabled: true,
      },
      ...tokens,
    };
  }

  private async loginAgent(
    authenticatedUser: {
      id: string;
      username: string;
      displayName: string;
      role: Role;
    },
    deviceInfo: LoginDeviceDto,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authenticatedUser.id}, 0))`;

        const user = await tx.user.findFirst({
          where: {
            id: authenticatedUser.id,
            role: Role.AGENT,
            status: UserStatus.ACTIVE,
          },
        });
        if (!user) {
          throw new UnauthorizedException({
            code: 'SESSION_INVALID',
            detail: '坐席账号已停用',
          });
        }

        const policy = await tx.mobileAppPolicy.upsert({
          where: { id: 'android' },
          create: { id: 'android' },
          update: {},
        });
        const versionAllowed = deviceInfo.appVersionCode >= policy.minimumVersionCode &&
          (!policy.forceUpgrade || deviceInfo.appVersionCode >= policy.latestVersionCode);
        if (!versionAllowed) {
          throw new ForbiddenException({
            code: 'APP_UPDATE_REQUIRED',
            detail: '当前 APP 版本已停用，请先完成更新',
          });
        }

        const allowedModel = policy.deviceCompatibilityRequired
          ? await tx.allowedDeviceModel.findUnique({
              where: {
                manufacturer_model_androidSdk: {
                  manufacturer: deviceInfo.manufacturer,
                  model: deviceInfo.model,
                  androidSdk: deviceInfo.androidSdk,
                },
              },
            })
          : null;
        if (policy.deviceCompatibilityRequired && !allowedModel?.enabled) {
          throw new ForbiddenException({
            code: 'DEVICE_NOT_ALLOWLISTED',
            detail: '该品牌、型号和 Android 版本未通过兼容性验证',
          });
        }

        const installDevice = await tx.device.findUnique({
          where: { installId: deviceInfo.installId },
        });
        if (installDevice && installDevice.userId !== user.id) {
          throw new ConflictException({
            code: 'INSTALL_ALREADY_BOUND',
            detail: '本机已绑定其他坐席账号',
          });
        }

        const now = new Date();
        const revokedDevices = await tx.device.updateMany({
          where: { userId: user.id, status: DeviceStatus.ACTIVE },
          data: { status: DeviceStatus.REVOKED, revokedAt: now },
        });
        await tx.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            tokenVersion: { increment: 1 },
            lastLoginAt: now,
          },
        });
        const currentDevice = installDevice
          ? await tx.device.update({
              where: { id: installDevice.id },
              data: {
                allowedDeviceModelId: allowedModel?.id ?? null,
                manufacturer: deviceInfo.manufacturer,
                model: deviceInfo.model,
                androidVersion: deviceInfo.androidVersion,
                androidSdk: deviceInfo.androidSdk,
                appVersion: deviceInfo.appVersion,
                appVersionCode: deviceInfo.appVersionCode,
                status: DeviceStatus.ACTIVE,
                activatedAt: now,
                revokedAt: null,
              },
            })
          : await tx.device.create({
              data: {
                userId: user.id,
                allowedDeviceModelId: allowedModel?.id ?? null,
                installId: deviceInfo.installId,
                manufacturer: deviceInfo.manufacturer,
                model: deviceInfo.model,
                androidVersion: deviceInfo.androidVersion,
                androidSdk: deviceInfo.androidSdk,
                appVersion: deviceInfo.appVersion,
                appVersionCode: deviceInfo.appVersionCode,
                status: DeviceStatus.ACTIVE,
                activatedAt: now,
              },
            });
        const tokens = await this.issueTokens(
          user.id,
          user.role,
          updatedUser.tokenVersion,
          currentDevice.id,
          tx,
        );
        await this.audit.record({
          actorId: user.id,
          action: 'MOBILE_DEVICE_LOGIN',
          entityType: 'device',
          entityId: currentDevice.id,
          metadata: {
            manufacturer: currentDevice.manufacturer,
            model: currentDevice.model,
            androidSdk: currentDevice.androidSdk,
            replacedActiveDevices: revokedDevices.count,
          },
        }, tx);
        return {
          user: {
            id: user.id,
            username: user.username,
            name: user.displayName,
            displayName: user.displayName,
            role: user.role,
            enabled: true,
          },
          deviceId: currentDevice.id,
          ...tokens,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      enabled: user.status === UserStatus.ACTIVE,
    };
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt <= new Date() ||
      stored.user.status !== UserStatus.ACTIVE
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        detail: '登录已失效，请重新登录',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (stored.deviceId) {
        const activeDevice = await tx.device.findFirst({
          where: {
            id: stored.deviceId,
            userId: stored.userId,
            status: DeviceStatus.ACTIVE,
          },
        });
        if (!activeDevice) {
          throw new UnauthorizedException({
            code: 'SESSION_REPLACED',
            detail: '账号已在其他手机登录，请重新登录',
          });
        }
      }
      const rotated = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!rotated.count) {
        throw new UnauthorizedException({ code: 'REFRESH_TOKEN_REUSED' });
      }
      return this.issueTokens(
        stored.user.id,
        stored.user.role,
        stored.user.tokenVersion,
        stored.deviceId ?? undefined,
        tx,
      );
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        detail: '当前密码错误',
      });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: await argon2.hash(next, { type: argon2.argon2id }),
          tokenVersion: { increment: 1 },
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      actorId: userId,
      action: 'AUTH_PASSWORD_CHANGED',
      entityType: 'user',
      entityId: userId,
    });
  }

  async validatePrincipal(principal: AuthPrincipal): Promise<AuthPrincipal> {
    const user = await this.prisma.user.findUnique({ where: { id: principal.sub } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        detail: '登录已失效，请重新登录',
      });
    }
    if (user.tokenVersion !== principal.tokenVersion) {
      throw new UnauthorizedException({
        code: 'SESSION_REPLACED',
        detail: '账号已在其他手机登录，当前设备已下线',
      });
    }
    if (principal.deviceId) {
      const device = await this.prisma.device.findFirst({
        where: {
          id: principal.deviceId,
          userId: user.id,
          status: 'ACTIVE',
        },
      });
      if (!device) {
        throw new UnauthorizedException({
          code: 'SESSION_REPLACED',
          detail: '账号已在其他手机登录，当前设备已下线',
        });
      }
    }
    return principal;
  }

  private async issueTokens(
    userId: string,
    role: AuthPrincipal['role'],
    tokenVersion: number,
    deviceId?: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const payload: AuthPrincipal = {
      sub: userId,
      role,
      tokenVersion,
      ...(deviceId ? { deviceId } : {}),
    };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL', '15m') as any,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshDays = Number(this.config.get('JWT_REFRESH_DAYS', '30'));
    await client.refreshToken.create({
      data: {
        userId,
        deviceId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshDays * 86_400_000),
      },
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 900,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
