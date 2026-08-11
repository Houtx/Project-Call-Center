import { Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { AuditQueryDto, CallQueryDto } from './reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard/stats')
  dashboard() {
    return this.reports.dashboard();
  }

  @Get('reports/summary')
  summary(@Query() query: CallQueryDto) {
    return this.reports.summary(query);
  }

  @Get('calls')
  calls(@Query() query: CallQueryDto) {
    return this.reports.calls(query);
  }

  @Post('calls/:id/phone')
  revealCallPhone(@Param('id') id: string, @Req() request: RequestWithPrincipal) {
    return this.reports.revealCallPhone(id, request.user.sub);
  }

  @Get('calls/export')
  async exportCalls(
    @Query() query: CallQueryDto,
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.reports.exportCalls(query, request.user.sub);
    response.type('text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="calls-${Date.now()}.csv"`);
    return content;
  }

  @Get('audit-events')
  audits(@Query() query: AuditQueryDto) {
    return this.reports.audits(query);
  }
}
