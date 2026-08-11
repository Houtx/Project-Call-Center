import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';

export enum DuplicateModeDto {
  SKIP = 'SKIP',
  UPDATE = 'UPDATE',
}

export class PreviewImportDto {
  @ApiProperty({ description: '本次导入所属批次' })
  @IsUUID()
  batchId!: string;
}

export class CommitImportDto {
  @ApiProperty()
  @IsUUID()
  importId!: string;

  @ApiProperty({ enum: DuplicateModeDto })
  @IsEnum(DuplicateModeDto)
  duplicateMode!: DuplicateModeDto;
}
