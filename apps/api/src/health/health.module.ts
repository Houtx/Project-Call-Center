import { Module } from '@nestjs/common';
import { BackgroundModule } from '../background/background.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';

@Module({ imports: [PrismaModule, BackgroundModule], controllers: [HealthController] })
export class HealthModule {}
