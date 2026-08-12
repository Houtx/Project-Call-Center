import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestWithPrincipal } from '../common/contracts';
import { CursorQueryDto, PageQueryDto, Roles } from '../common/contracts';
import {
  CallObservationBatchDto,
  CreateCallAttemptDto,
  HeartbeatDto,
} from './mobile.dto';
import { MobileService } from './mobile.service';

@ApiTags('mobile')
@Controller('mobile')
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Get('bootstrap')
  bootstrap(@Req() request: RequestWithPrincipal) {
    return this.mobile.bootstrap(request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Get('sync')
  sync(@Req() request: RequestWithPrincipal, @Query() query: CursorQueryDto) {
    return this.mobile.sync(request.user, query.cursor, query.limit);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('assignments/:assignmentId/phone')
  revealPhone(
    @Param('assignmentId') assignmentId: string,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.mobile.revealPhone(assignmentId, request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('call-attempts')
  createAttempt(
    @Body() body: CreateCallAttemptDto,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.mobile.createCallAttempt(body, request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('call-attempts/:attemptId/cancel')
  cancelAttempt(
    @Param('attemptId') attemptId: string,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.mobile.cancelCallAttempt(attemptId, request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('call-log-results:batch')
  uploadResults(
    @Body() body: CallObservationBatchDto,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.mobile.observeCalls(body, request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('heartbeat')
  @HttpCode(204)
  heartbeat(@Body() body: HeartbeatDto, @Req() request: RequestWithPrincipal) {
    return this.mobile.heartbeat(body, request.user);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Get('calls')
  history(@Req() request: RequestWithPrincipal, @Query() query: PageQueryDto) {
    return this.mobile.history(request.user, query.page, query.pageSize);
  }

  @ApiBearerAuth()
  @Roles(Role.AGENT)
  @Post('calls/:attemptId/phone')
  revealHistoryPhone(
    @Param('attemptId') attemptId: string,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.mobile.revealHistoryPhone(attemptId, request.user);
  }
}
