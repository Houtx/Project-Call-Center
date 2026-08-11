import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { RequestWithPrincipal } from '../common/contracts';
import { Public } from '../common/contracts';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './auth.dto';

@ApiTags('authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password, body.device);
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
