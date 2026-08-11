import { Module } from '@nestjs/common';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { CallReconciliationService } from './reconciliation.service';

@Module({
  controllers: [MobileController],
  providers: [MobileService, CallReconciliationService],
  exports: [CallReconciliationService],
})
export class MobileModule {}
