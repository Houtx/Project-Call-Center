import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAgentDto {
  @ApiProperty()
  @IsString()
  @MaxLength(80)
  username!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  displayName!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  password!: string;
}

export class UpdateAgentDto {
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(120)
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Web client alias for active' })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  password!: string;
}

export class AllowedDeviceModelDto {
  @ApiProperty()
  @IsString()
  manufacturer!: string;

  @ApiProperty()
  @IsString()
  model!: string;

  @ApiProperty({ minimum: 31 })
  @IsInt()
  @Min(31)
  androidSdk!: number;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string;
}

export class UpdateAllowedDeviceModelDto {
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string;
}

export class UpdateMobileAppPolicyDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  minimumVersionCode!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  latestVersionCode!: number;

  @ApiProperty()
  @IsBoolean()
  forceUpgrade!: boolean;

  @ApiPropertyOptional({
    default: true,
    description: '是否要求设备品牌、型号和 Android API 命中机型白名单',
  })
  @IsBoolean()
  @IsOptional()
  deviceCompatibilityRequired?: boolean;

  @ApiPropertyOptional({
    default: 2,
    minimum: 1,
    maximum: 10,
    description: '单个客户允许发起的最大外呼次数',
  })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  maxCallAttempts?: number;

  @ApiPropertyOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(512)
  @IsOptional()
  downloadUrl?: string;
}
