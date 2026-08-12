import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { RequestWithPrincipal } from '../common/contracts';
import { Public } from '../common/contracts';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './auth.dto';
import { LoginRateLimitService } from './login-rate-limit.service';

@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly loginRateLimit: LoginRateLimitService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() request: Request) {
    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    this.loginRateLimit.assertAllowed(clientIp, body.username);
    try {
      const result = await this.auth.login(body.username, body.password, body.device);
      this.loginRateLimit.recordSuccess(body.username);
      return result;
    } catch (error) {
      if (this.isInvalidCredentials(error)) {
        this.loginRateLimit.recordFailure(clientIp, body.username);
      }
      throw error;
    }
  }

  private isInvalidCredentials(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('getResponse' in error)) return false;
    const response = (error as { getResponse: () => unknown }).getResponse();
    return Boolean(
      response && typeof response === 'object' &&
      (response as { code?: unknown }).code === 'INVALID_CREDENTIALS',
    );
  }

  @ApiBearerAuth()
  @Get('me')
  me(@Req() request: RequestWithPrincipal) {
    return this.auth.me(request.user.sub);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Body() body: RefreshDto) {
    return this.auth.logout(body.refreshToken);
  }

  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(204)
  changePassword(
    @Req() request: RequestWithPrincipal,
    @Body() body: ChangePasswordDto,
  ) {
    return this.auth.changePassword(
      request.user.sub,
      body.currentPassword,
      body.newPassword,
    );
  }
}
