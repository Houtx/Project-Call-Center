import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/contracts';

export class CreateBatchDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(64)
  @IsOptional()
  code?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

export class UpdateBatchDto {
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  code?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

export class CreateCustomerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: '13800000001' })
  @IsString()
  phone!: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  batchId?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  province?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  carrier?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  tags?: string[];
}

export class PhoneAttributionDto {
  @ApiProperty({ example: '13800000001' })
  @IsString()
  @MaxLength(32)
  phone!: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  batchId?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  province?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(80)
  @IsOptional()
  carrier?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiProperty({ description: 'Optimistic concurrency version' })
  @IsInt()
  @Min(1)
  version!: number;
}

export class CustomerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsEnum(['ACTIVE', 'ARCHIVED'])
  @IsOptional()
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ enum: ['UNASSIGNED', 'ASSIGNED', 'COMPLETED', 'WITHDRAWN', 'NOT_CONNECTED'] })
  @IsEnum(['UNASSIGNED', 'ASSIGNED', 'COMPLETED', 'WITHDRAWN', 'NOT_CONNECTED'])
  @IsOptional()
  assignmentStatus?: 'UNASSIGNED' | 'ASSIGNED' | 'COMPLETED' | 'WITHDRAWN' | 'NOT_CONNECTED';

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  batchId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Exact phone search' })
  @IsString()
  @IsOptional()
  phone?: string;
}

export class CustomerIdsDto {
  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsUUID(undefined, { each: true })
  customerIds!: string[];
}

export class EraseCustomerDto {
  @ApiProperty({ description: '合规删除原因' })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}
