import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { AttemptStatus } from '@prisma/client';
import { PageQueryDto } from '../common/contracts';

export class CallQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  batchId?: string;

  @ApiPropertyOptional({ enum: AttemptStatus })
  @IsEnum(AttemptStatus)
  @IsOptional()
  status?: AttemptStatus;
}

export class AuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  action?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  resourceType?: string;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  to?: string;
}
