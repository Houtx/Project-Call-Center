import { Controller, Get } from '@nestjs/common';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { Public } from '../common/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      database: 'up',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.6.4',
      backgroundJobs: this.backgroundJobs.status(),
    };
  }
}
