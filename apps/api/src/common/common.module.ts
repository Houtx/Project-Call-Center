import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { IdempotencyService } from './idempotency.service';
import { PhoneAttributionService } from './phone-attribution.service';

@Global()
@Module({
  providers: [AuditService, CryptoService, IdempotencyService, PhoneAttributionService],
  exports: [AuditService, CryptoService, IdempotencyService, PhoneAttributionService],
})
export class CommonModule {}
