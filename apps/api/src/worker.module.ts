import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BackgroundModule } from './background/background.module';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    BackgroundModule,
  ],
})
export class WorkerModule {}
