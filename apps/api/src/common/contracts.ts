import { SetMetadata } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { Role } from '@prisma/client';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthPrincipal {
  sub: string;
  role: Role;
  deviceId?: string;
  tokenVersion: number;
}

export interface RequestWithPrincipal extends Request {
  user: AuthPrincipal;
  requestId: string;
}

export class PageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  pageSize = 20;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}

export class CursorQueryDto {
  @ApiPropertyOptional({ description: 'Opaque monotonic sync cursor' })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ default: 200, maximum: 500 })
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit = 200;
}

export class IdempotencyHeaderDto {
  @ApiProperty({ description: 'Stable UUID or random key unique to this command' })
  @IsString()
  key!: string;
}

export class ActiveQueryDto {
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
