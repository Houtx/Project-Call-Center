import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AssignmentsModule } from './assignments/assignments.module';
import { AuthModule } from './auth/auth.module';
import { BackgroundModule } from './background/background.module';
import { JwtAuthGuard, RolesGuard } from './auth/auth.guards';
import { CommonModule } from './common/common.module';
import { CustomersModule } from './customers/customers.module';
import { HealthModule } from './health/health.module';
import { ImportsModule } from './imports/imports.module';
import { MobileModule } from './mobile/mobile.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { SuppressionModule } from './suppression/suppression.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CommonModule,
    AuthModule,
    CustomersModule,
    AssignmentsModule,
    UsersModule,
    SuppressionModule,
    ImportsModule,
    MobileModule,
    ReportsModule,
    BackgroundModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
})
export class AppModule {}
