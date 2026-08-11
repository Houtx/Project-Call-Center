import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PermissionState } from '@prisma/client';

export class CreateCallAttemptDto {
  @ApiProperty()
  @IsString()
  assignmentId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  clientAttemptId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  callLogBaselineId!: string;

  @ApiProperty()
  @IsISO8601()
  callLogBaselineAt!: string;
}

export class CallObservationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  eventId!: string;

  @ApiProperty()
  @IsString()
  attemptId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  systemCallLogId!: string;

  @ApiProperty()
  @IsISO8601()
  systemCallStartedAt!: string;

  @ApiProperty()
  @IsISO8601()
  systemCallEndedAt!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 86400 })
  @IsInt()
  @Min(0)
  @Max(86_400)
  @IsOptional()
  durationSeconds?: number;

  @ApiProperty()
  @IsISO8601()
  clientObservedAt!: string;
}

export class CallObservationBatchDto {
  @ApiProperty({ type: [CallObservationDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CallObservationDto)
  results!: CallObservationDto[];
}

export class HeartbeatDto {
  @ApiProperty()
  @IsString()
  @MaxLength(40)
  appVersion!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  appVersionCode!: number;

  @ApiProperty({ enum: PermissionState })
  @IsEnum(PermissionState)
  callPhonePermission!: PermissionState;

  @ApiProperty({ enum: PermissionState })
  @IsEnum(PermissionState)
  callLogPermission!: PermissionState;
}
