import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/contracts';

export class AddSuppressionDto {
  @ApiProperty({ example: '13800000001' })
  @IsString()
  phone!: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(255)
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ enum: ['MANUAL', 'IMPORT', 'CUSTOMER_REQUEST', 'COMPLIANCE'] })
  @IsIn(['MANUAL', 'IMPORT', 'CUSTOMER_REQUEST', 'COMPLIANCE'])
  @IsOptional()
  source?: 'MANUAL' | 'IMPORT' | 'CUSTOMER_REQUEST' | 'COMPLIANCE';
}

export class SuppressionQueryDto extends PageQueryDto {}
