import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class AssignCustomersDto {
  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsUUID(undefined, { each: true })
  customerIds!: string[];

  @ApiProperty()
  @IsUUID()
  agentId!: string;
}

export class WithdrawCustomersDto {
  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsUUID(undefined, { each: true })
  customerIds!: string[];
}

export class ReclaimAssignmentsDto {
  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsUUID(undefined, { each: true })
  assignmentIds!: string[];

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(255)
  @IsOptional()
  reason?: string;
}

export class ReassignCustomersDto extends ReclaimAssignmentsDto {
  @ApiProperty()
  @IsUUID()
  agentId!: string;
}

export class BulkAssignmentDto {
  @ApiProperty({ enum: ['FILTER', 'ALL'] })
  @IsEnum(['FILTER', 'ALL'])
  scope!: 'FILTER' | 'ALL';

  @ApiProperty({ type: [String], description: '按顺序平均分配的目标坐席', minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  agentIds!: string[];

  @ApiProperty({ description: '本次分配的客户总数', minimum: 1, maximum: 1000000 })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsEnum(['ACTIVE', 'ARCHIVED'])
  @IsOptional()
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  batchId?: string;

  @ApiPropertyOptional({ description: '按当前归属坐席筛选' })
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({ enum: ['UNASSIGNED', 'ASSIGNED', 'COMPLETED', 'WITHDRAWN', 'NOT_CONNECTED'] })
  @IsEnum(['UNASSIGNED', 'ASSIGNED', 'COMPLETED', 'WITHDRAWN', 'NOT_CONNECTED'])
  @IsOptional()
  assignmentStatus?: 'UNASSIGNED' | 'ASSIGNED' | 'COMPLETED' | 'WITHDRAWN' | 'NOT_CONNECTED';

  @ApiPropertyOptional({ description: '精确手机号筛选' })
  @IsString()
  @IsOptional()
  phone?: string;
}

export class RetryAssignCustomersDto {
  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsUUID(undefined, { each: true })
  customerIds!: string[];

  @ApiProperty()
  @IsUUID()
  agentId!: string;
}
