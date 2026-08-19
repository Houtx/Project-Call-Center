import { UnauthorizedException } from '@nestjs/common';
import { DeviceStatus, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

describe('AuthService mobile single-session login', () => {
  it('revokes the first phone when the same agent logs in on a second phone', async () => {
    const user = {
      id: '00000000-0000-4000-8000-000000000001',
      username: 'agent001',
      displayName: '测试坐席',
      passwordHash: await argon2.hash('test-only-agent-password'),
      role: Role.AGENT,
      status: UserStatus.ACTIVE,
      tokenVersion: 0,
      lastLoginAt: null as Date | null,
    };
    const devices: Array<Record<string, any>> = [];
    const refreshTokens: Array<Record<string, any>> = [];
    const signedPrincipals: Array<Record<string, any>> = [];
    let deviceSequence = 0;
    let refreshSequence = 0;

    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      user: {
        findFirst: jest.fn().mockImplementation(async () => ({ ...user })),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.tokenVersion?.increment) user.tokenVersion += data.tokenVersion.increment;
          if (data.lastLoginAt) user.lastLoginAt = data.lastLoginAt;
          return { ...user };
        }),
      },
      mobileAppPolicy: {
        upsert: jest.fn().mockResolvedValue({
          id: 'android',
          minimumVersionCode: 1,
          latestVersionCode: 1,
          forceUpgrade: false,
          deviceCompatibilityRequired: false,
        }),
      },
      allowedDeviceModel: { findUnique: jest.fn() },
      assignment: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'assignment-1',
          customerId: 'customer-1',
        }]),
      },
      syncChange: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      device: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
          devices.find((item) => item.installId === where.installId) ?? null),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          devices.find((item) =>
            item.id === where.id && item.userId === where.userId && item.status === where.status) ?? null),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          let count = 0;
          devices.forEach((item) => {
            if (item.userId === where.userId && item.status === where.status) {
              Object.assign(item, data);
              count += 1;
            }
          });
          return { count };
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const item = devices.find((candidate) => candidate.id === where.id)!;
          Object.assign(item, data);
          return { ...item };
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const item = { id: `device-${++deviceSequence}`, ...data };
          devices.push(item);
          return { ...item };
        }),
      },
      refreshToken: {
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          let count = 0;
          refreshTokens.forEach((item) => {
            const matchesUser = !where.userId || item.userId === where.userId;
            const matchesId = !where.id || item.id === where.id;
            const matchesRevocation = where.revokedAt === null ? item.revokedAt === null : true;
            if (matchesUser && matchesId && matchesRevocation) {
              Object.assign(item, data);
              count += 1;
            }
          });
          return { count };
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const item = {
            id: `refresh-${++refreshSequence}`,
            ...data,
            revokedAt: null,
          };
          refreshTokens.push(item);
          return item;
        }),
      },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
          where.username === user.username || where.id === user.id ? { ...user } : null),
        update: jest.fn(),
      },
      device: {
        findFirst: tx.device.findFirst,
      },
      refreshToken: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          const stored = refreshTokens.find((item) => item.tokenHash === where.tokenHash);
          return stored ? { ...stored, user: { ...user } } : null;
        }),
      },
      $transaction: jest.fn().mockImplementation(async (operation: (client: typeof tx) => unknown) =>
        operation(tx)),
    };
    const jwt = {
      signAsync: jest.fn().mockImplementation(async (principal: Record<string, any>) => {
        signedPrincipals.push({ ...principal });
        return `access-${signedPrincipals.length}`;
      }),
    };
    const config = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as any,
      jwt as any,
      config as any,
      audit as any,
    );
    const device = (installId: string) => ({
      installId,
      manufacturer: 'Samsung',
      model: 'SM-F9660',
      androidVersion: '16',
      androidSdk: 36,
      appVersion: '0.4.0-debug',
      appVersionCode: 4,
    });

    const first = await service.login(user.username, 'test-only-agent-password', device('phone-a'));
    const firstPrincipal = signedPrincipals[0];
    const second = await service.login(user.username, 'test-only-agent-password', device('phone-b'));
    const secondPrincipal = signedPrincipals[1];

    expect('deviceId' in first && first.deviceId).toBe('device-1');
    expect('deviceId' in second && second.deviceId).toBe('device-2');
    expect(devices.filter((item) => item.status === DeviceStatus.ACTIVE)).toEqual([
      expect.objectContaining({ id: 'device-2', installId: 'phone-b' }),
    ]);
    expect(refreshTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(refreshTokens[1].revokedAt).toBeNull();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.syncChange.createMany).toHaveBeenCalledTimes(2);
    expect(tx.syncChange.createMany).toHaveBeenLastCalledWith({
      data: [{
        targetUserId: user.id,
        entityType: 'ASSIGNMENT',
        entityId: 'assignment-1',
        operation: 'UPSERT',
        payload: { assignmentId: 'assignment-1', customerId: 'customer-1' },
      }],
    });

    await expect(service.validatePrincipal(firstPrincipal as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.validatePrincipal(secondPrincipal as any)).resolves.toEqual(secondPrincipal);
  });

  it('requires device details for an agent login', async () => {
    const password = 'test-only-agent-password';
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000001',
          username: 'agent001',
          displayName: '测试坐席',
          passwordHash: await argon2.hash(password),
          role: Role.AGENT,
          status: UserStatus.ACTIVE,
          tokenVersion: 0,
        }),
      },
    };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.login('agent001', password)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
