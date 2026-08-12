import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { PageQueryDto } from '../common/contracts';
import { IdempotencyService } from '../common/idempotency.service';
import {
  AllowedDeviceModelDto,
  CreateAgentDto,
  ResetPasswordDto,
  UpdateAgentDto,
  UpdateAllowedDeviceModelDto,
  UpdateMobileAppPolicyDto,
} from './users.dto';
import { UsersService } from './users.service';

@ApiTags('agents and devices')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('agents')
  agents(@Query() query: PageQueryDto) {
    return this.users.listAgents(query);
  }

  @Post('agents')
  createAgent(
    @Body() body: CreateAgentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'agents.create',
      key,
      body,
      (tx) => this.users.createAgent(body, req.user.sub, tx),
    );
  }

  @Patch('agents/:id')
  updateAgent(
    @Param('id') id: string,
    @Body() body: UpdateAgentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'agents.update',
      key,
      { id, ...body },
      (tx) => this.users.updateAgent(id, body, req.user.sub, tx),
    );
  }

  @Post('agents/:id/reset-password')
  @HttpCode(204)
  resetPassword(
    @Param('id') id: string,
    @Body() body: ResetPasswordDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'agents.reset-password',
      key,
      { id, passwordHash: createHash('sha256').update(body.password).digest('hex') },
      (tx) => this.users.resetPassword(id, body.password, req.user.sub, tx),
    );
  }

  @Get('devices')
  devices() {
    return this.users.listDevices();
  }

  @Post('devices/:id/revoke')
  @HttpCode(204)
  revokeDevice(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'devices.revoke',
      key,
      { id },
      (tx) => this.users.revokeDevice(id, req.user.sub, tx),
    );
  }

  @Delete('agents/:id/device')
  @HttpCode(204)
  revokeAgentDevice(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'devices.revoke',
      key,
      { id },
      (tx) => this.users.revokeAgentDevice(id, req.user.sub, tx),
    );
  }

  @Get('device-models')
  allowedModels() {
    return this.users.listAllowedModels();
  }

  @Post('device-models')
  addAllowedModel(
    @Body() body: AllowedDeviceModelDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'device-models.create',
      key,
      body,
      (tx) => this.users.addAllowedModel(body, req.user.sub, tx),
    );
  }

  @Patch('device-models/:id')
  updateAllowedModel(
    @Param('id') id: string,
    @Body() body: UpdateAllowedDeviceModelDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'device-models.update',
      key,
      { id, ...body },
      (tx) => this.users.updateAllowedModel(id, body, req.user.sub, tx),
    );
  }

  @Get('mobile-app-policy')
  mobileAppPolicy() {
    return this.users.getMobileAppPolicy();
  }

  @Patch('mobile-app-policy')
  updateMobileAppPolicy(
    @Body() body: UpdateMobileAppPolicyDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      req.user.sub,
      'mobile-app-policy.update',
      key,
      body,
      (tx) => this.users.updateMobileAppPolicy(body, req.user.sub, tx),
    );
  }
}
