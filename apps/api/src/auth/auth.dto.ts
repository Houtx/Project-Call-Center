import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class LoginDeviceDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  installId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  manufacturer!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  model!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(40)
  androidVersion!: string;

  @ApiProperty({ minimum: 31 })
  @IsInt()
  @Min(31)
  androidSdk!: number;

  @ApiProperty()
  @IsString()
  @MaxLength(40)
  appVersion!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  appVersionCode!: number;
}

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  username!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ type: LoginDeviceDto })
  @ValidateNested()
  @Type(() => LoginDeviceDto)
  @IsOptional()
  device?: LoginDeviceDto;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  newPassword!: string;
}
