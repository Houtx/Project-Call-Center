import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { IdempotencyService } from '../common/idempotency.service';
import {
  AssignCustomersDto,
  BulkAssignmentDto,
  ReassignCustomersDto,
  ReclaimAssignmentsDto,
  RetryAssignCustomersDto,
  WithdrawCustomersDto,
} from './assignments.dto';
import { AssignmentsService } from './assignments.service';

@ApiTags('assignments')
@ApiBearerAuth()
@ApiHeader({ name: 'Idempotency-Key', required: true })
@Roles(Role.ADMIN)
@Controller('assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  assignSelected(
    @Body() body: AssignCustomersDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.assign-selected',
      key,
      body,
      async (tx) => ({
        assigned: await this.assignments.assignOrReassign(
          body.customerIds,
          body.agentId,
          request.user.sub,
          true,
          tx,
        ),
      }),
    );
  }

  @Post('withdraw')
  withdrawSelected(
    @Body() body: WithdrawCustomersDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.withdraw-selected',
      key,
      body,
      async (tx) => ({
        withdrawn: await this.assignments.reclaimCustomers(body.customerIds, request.user.sub, tx),
      }),
    );
  }

  @Post('retry')
  retryAssign(
    @Body() body: RetryAssignCustomersDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.retry',
      key,
      body,
      async (tx) => ({
        assigned: await this.assignments.retryAssign(
          body.customerIds,
          body.agentId,
          request.user.sub,
          true,
          tx,
        ),
      }),
    );
  }

  @Post('bulk/preview')
  previewBulk(@Body() body: BulkAssignmentDto) {
    return this.assignments.previewBulk(body);
  }

  @Post('bulk')
  bulk(
    @Body() body: BulkAssignmentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.bulk',
      key,
      body,
      (tx) => this.assignments.bulkAssign(body, request.user.sub, tx),
    );
  }

  @Post('assign')
  assign(
    @Body() body: AssignCustomersDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.assign',
      key,
      body,
      (tx) => this.assignments.assign(body.customerIds, body.agentId, request.user.sub, tx),
    );
  }

  @Post('reclaim')
  reclaim(
    @Body() body: ReclaimAssignmentsDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.reclaim',
      key,
      body,
      (tx) => this.assignments.reclaim(body.assignmentIds, request.user.sub, body.reason, tx),
    );
  }

  @Post('reassign')
  reassign(
    @Body() body: ReassignCustomersDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'assignments.reassign',
      key,
      body,
      (tx) =>
        this.assignments.reassign(
          body.assignmentIds,
          body.agentId,
          request.user.sub,
          body.reason,
          tx,
        ),
    );
  }
}
