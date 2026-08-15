import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallRecordingStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordingUpload {
  buffer: Buffer;
  mimetype: string;
  durationSeconds?: number;
}

export interface RecordingFile {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/3gpp', 'audio/amr', 'audio/aac']);

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);
  private readonly root: string;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    this.root = resolve(this.config.get<string>('RECORDINGS_DIR') ?? join(process.cwd(), 'storage', 'recordings'));
    this.encryptionKey = this.readEncryptionKey(this.config.get<string>('RECORDING_ENCRYPTION_KEY'));
  }

  isAllowedMimeType(mimetype: string): boolean {
    return ALLOWED_MIME_TYPES.has(mimetype.toLowerCase());
  }

  async createPending(attemptId: string, agentId: string, deviceId: string, client?: Prisma.TransactionClient) {
    const db = client ?? this.prisma;
    return db.callRecording.create({ data: { attemptId, agentId, deviceId } });
  }

  async markUnsupported(attemptId: string, agentId: string, deviceId: string, reason: string) {
    const result = await this.prisma.callRecording.updateMany({
      where: { attemptId, agentId, deviceId, status: CallRecordingStatus.PENDING },
      data: { status: CallRecordingStatus.UNSUPPORTED, failureCode: reason },
    });
    if (result.count) {
      await this.audit.record({
        actorId: agentId,
        action: 'MOBILE_CALL_RECORDING_UNSUPPORTED',
        entityType: 'call_recording',
        entityId: attemptId,
        metadata: { deviceId, reason },
      });
    }
    return { marked: result.count > 0 };
  }

  async upload(attemptId: string, agentId: string, deviceId: string, upload: RecordingUpload) {
    if (!upload.buffer?.length || upload.buffer.length > MAX_RECORDING_BYTES) {
      throw new ConflictException({ code: 'RECORDING_SIZE_INVALID', detail: '录音文件为空或超过 25 MB' });
    }
    if (!this.isAllowedMimeType(upload.mimetype)) {
      throw new ConflictException({ code: 'RECORDING_FORMAT_UNSUPPORTED', detail: '只支持压缩音频格式（AAC/M4A/3GP/AMR）' });
    }
    const recording = await this.prisma.callRecording.findUnique({ where: { attemptId } });
    if (!recording || recording.agentId !== agentId || recording.deviceId !== deviceId) {
      throw new NotFoundException({ code: 'CALL_RECORDING_NOT_FOUND' });
    }
    if (recording.status === CallRecordingStatus.READY) return this.metadata(recording);
    if (recording.status === CallRecordingStatus.DELETED) {
      throw new ConflictException({ code: 'CALL_RECORDING_DELETED' });
    }
    const claim = await this.prisma.callRecording.updateMany({
      where: { id: recording.id, status: { in: [CallRecordingStatus.PENDING, CallRecordingStatus.FAILED, CallRecordingStatus.UNSUPPORTED] } },
      data: { status: CallRecordingStatus.UPLOADING, failureCode: null },
    });
    if (!claim.count) {
      const current = await this.prisma.callRecording.findUnique({ where: { id: recording.id } });
      if (current?.status === CallRecordingStatus.READY) return this.metadata(current);
      throw new ConflictException({ code: 'CALL_RECORDING_UPLOAD_IN_PROGRESS' });
    }

    const objectKey = `recordings/${agentId}/${attemptId}.${this.extension(upload.mimetype)}`;
    const destination = this.safePath(objectKey);
    const temporary = `${destination}.${Date.now()}.uploading`;
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o750 });
      await writeFile(temporary, this.encrypt(upload.buffer), { mode: 0o640 });
      await rename(temporary, destination);
      const digest = createHash('sha256').update(upload.buffer).digest('hex');
      const policy = await this.prisma.mobileAppPolicy.findUnique({ where: { id: 'android' } });
      const retentionDays = policy?.recordingRetentionDays ?? 30;
      const updated = await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: {
          status: CallRecordingStatus.READY,
          objectKey,
          mimeType: upload.mimetype.toLowerCase(),
          sizeBytes: upload.buffer.length,
          durationSeconds: upload.durationSeconds,
          sha256: digest,
          uploadedAt: new Date(),
          expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
        },
      });
      await this.audit.record({
        actorId: agentId,
        action: 'MOBILE_CALL_RECORDING_UPLOADED',
        entityType: 'call_recording',
        entityId: recording.id,
        metadata: { deviceId, mimeType: upload.mimetype, sizeBytes: upload.buffer.length, durationSeconds: upload.durationSeconds },
      });
      return this.metadata(updated);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: { status: CallRecordingStatus.FAILED, failureCode: 'STORAGE_WRITE_FAILED' },
      }).catch(() => undefined);
      throw error;
    }
  }

  async open(attemptId: string, actorId: string, download: boolean): Promise<RecordingFile> {
    const recording = await this.prisma.callRecording.findUnique({ where: { attemptId } });
    if (!recording || recording.status !== CallRecordingStatus.READY || !recording.objectKey) {
      throw new NotFoundException({ code: 'CALL_RECORDING_NOT_READY' });
    }
    const path = this.safePath(recording.objectKey);
    let details;
    let encrypted;
    try {
      details = await stat(path);
      encrypted = await import('node:fs/promises').then(({ readFile }) => readFile(path));
    } catch {
      await this.prisma.callRecording.update({ where: { id: recording.id }, data: { status: CallRecordingStatus.FAILED, failureCode: 'FILE_MISSING' } }).catch(() => undefined);
      throw new NotFoundException({ code: 'CALL_RECORDING_FILE_MISSING' });
    }
    let plaintext: Buffer;
    try {
      plaintext = this.decrypt(encrypted);
    } catch {
      await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: { status: CallRecordingStatus.FAILED, failureCode: 'FILE_INVALID' },
      }).catch(() => undefined);
      throw new ConflictException({ code: 'RECORDING_FILE_INVALID' });
    }
    await this.audit.record({
      actorId,
      action: download ? 'CALL_RECORDING_DOWNLOADED' : 'CALL_RECORDING_PLAYED',
      entityType: 'call_recording',
      entityId: recording.id,
      metadata: { mimeType: recording.mimeType, sizeBytes: details.size },
    });
    return {
      stream: Readable.from(plaintext),
      mimeType: recording.mimeType ?? 'audio/mp4',
      sizeBytes: recording.sizeBytes ?? details.size,
      fileName: `call-${attemptId}.${this.extension(recording.mimeType ?? 'audio/mp4')}`,
    };
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const rows = await this.prisma.callRecording.findMany({
      where: {
        expiresAt: { lt: now },
        status: CallRecordingStatus.READY,
      },
      take: 500,
    });
    let cleaned = 0;
    for (const row of rows) {
      if (row.objectKey) {
        try {
          await unlink(this.safePath(row.objectKey));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.error(`Unable to delete expired recording ${row.id}; cleanup will retry`);
            continue;
          }
        }
      }
      await this.prisma.callRecording.update({
        where: { id: row.id },
        data: { status: CallRecordingStatus.DELETED, deletedAt: new Date() },
      });
      cleaned += 1;
    }
    if (cleaned) {
      await this.audit.record({
        action: 'CALL_RECORDINGS_CLEANED',
        entityType: 'call_recording',
        metadata: { count: cleaned },
      });
    }
    return cleaned;
  }

  metadata(recording: { id: string; status: CallRecordingStatus; mimeType: string | null; sizeBytes: number | null; durationSeconds: number | null; createdAt: Date; uploadedAt: Date | null; deletedAt: Date | null }) {
    return {
      id: recording.id,
      status: recording.status,
      mimeType: recording.mimeType,
      sizeBytes: recording.sizeBytes,
      durationSeconds: recording.durationSeconds,
      createdAt: recording.createdAt,
      uploadedAt: recording.uploadedAt,
      deletedAt: recording.deletedAt,
    };
  }

  private safePath(objectKey: string): string {
    const path = resolve(this.root, objectKey);
    if (relative(this.root, path).startsWith('..')) throw new ConflictException({ code: 'RECORDING_PATH_INVALID' });
    return path;
  }

  private extension(mimetype: string): string {
    return mimetype.toLowerCase() === 'audio/3gpp' || mimetype.toLowerCase() === 'audio/amr' ? '3gp' : 'm4a';
  }

  private encrypt(plaintext: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(payload: Buffer): Buffer {
    if (payload.length < 29) throw new ConflictException({ code: 'RECORDING_FILE_INVALID' });
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
  }

  private readEncryptionKey(value?: string): Buffer {
    if (!value) {
      if (process.env.NODE_ENV === 'production') throw new Error('RECORDING_ENCRYPTION_KEY is required in production');
      return createHash('sha256').update('development-recording-key').digest();
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error('RECORDING_ENCRYPTION_KEY must be a base64-encoded 32 byte key');
    return key;
  }
}
