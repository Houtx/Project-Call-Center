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
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { IdempotencyService } from '../common/idempotency.service';
import {
  CreateBatchDto,
  CreateCustomerDto,
  CustomerQueryDto,
  EraseCustomerDto,
  PhoneAttributionDto,
  UpdateBatchDto,
  UpdateCustomerDto,
} from './customers.dto';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('customers')
  list(@Query() query: CustomerQueryDto) {
    return this.customers.list(query);
  }

  @Get('customers/:id')
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Post('customers/phone-attribution')
  phoneAttribution(@Body() body: PhoneAttributionDto) {
    return this.customers.lookupPhoneAttribution(body.phone);
  }

  @Post('customers')
  create(
    @Body() body: CreateCustomerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.create',
      key,
      body,
      (tx) => this.customers.create(body, request.user.sub, tx),
    );
  }

  @Patch('customers/:id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateCustomerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.update',
      key,
      { id, ...body },
      (tx) => this.customers.update(id, body, request.user.sub, tx),
    );
  }

  @Delete('customers/:id')
  @HttpCode(204)
  archive(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.archive',
      key,
      { id },
      (tx) => this.customers.archive(id, request.user.sub, tx),
    );
  }

  @Post('customers/:id/archive')
  @HttpCode(204)
  archiveAlias(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.archive',
      key,
      { id },
      (tx) => this.customers.archive(id, request.user.sub, tx),
    );
  }

  @Post('customers/:id/erase')
  @HttpCode(204)
  erase(
    @Param('id') id: string,
    @Body() body: EraseCustomerDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.erase',
      key,
      { id, ...body },
      (tx) => this.customers.erasePersonalData(id, body.reason, request.user.sub, tx),
    );
  }

  @Post('customers/:id/phone')
  revealPhone(@Param('id') id: string, @Req() request: RequestWithPrincipal) {
    return this.customers.revealPhone(id, request.user.sub);
  }

  @Get('batches')
  batches(@Query() query: CustomerQueryDto) {
    return this.customers.listBatches(query);
  }

  @Post('batches')
  createBatch(
    @Body() body: CreateBatchDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'batches.create',
      key,
      body,
      (tx) => this.customers.createBatch(body, request.user.sub, tx),
    );
  }

  @Patch('batches/:id')
  updateBatch(
    @Param('id') id: string,
    @Body() body: UpdateBatchDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'batches.update',
      key,
      { id, ...body },
      (tx) => this.customers.updateBatch(id, body, tx),
    );
  }
}
