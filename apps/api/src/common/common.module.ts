import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CryptoService } from './crypto.service';
import { IdempotencyService } from './idempotency.service';
import { PhoneAttributionService } from './phone-attribution.service';
import { RecordingService } from './recording.service';

@Global()
@Module({
  providers: [AuditService, CryptoService, IdempotencyService, PhoneAttributionService, RecordingService],
  exports: [AuditService, CryptoService, IdempotencyService, PhoneAttributionService, RecordingService],
})
export class CommonModule {}
