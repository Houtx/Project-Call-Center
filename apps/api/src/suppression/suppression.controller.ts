import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { IdempotencyService } from '../common/idempotency.service';
import { AddSuppressionDto, SuppressionQueryDto } from './suppression.dto';
import { SuppressionService } from './suppression.service';

@ApiTags('suppression')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('suppression')
export class SuppressionController {
  constructor(
    private readonly suppression: SuppressionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Query() query: SuppressionQueryDto) {
    return this.suppression.list(query);
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  add(
    @Body() body: AddSuppressionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'suppression.add',
      key,
      body,
      () => this.suppression.add(body, request.user.sub),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'suppression.revoke',
      key,
      { id },
      () => this.suppression.revoke(id, request.user.sub),
    );
  }

  @Post(':id/revoke')
  @HttpCode(204)
  revokeAlias(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'suppression.revoke',
      key,
      { id },
      () => this.suppression.revoke(id, request.user.sub),
    );
  }
}
