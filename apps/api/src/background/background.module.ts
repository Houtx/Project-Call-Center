import { Module } from '@nestjs/common';
import { CallReconciliationService } from '../mobile/reconciliation.service';
import { BackgroundJobsService } from './background-jobs.service';

@Module({
  providers: [CallReconciliationService, BackgroundJobsService],
  exports: [BackgroundJobsService],
})
export class BackgroundModule {}
