import { CallRecordingStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingService } from './recording.service';

describe('RecordingService', () => {
  const config = {
    get: jest.fn((key: string) => key === 'RECORDINGS_DIR'
      ? '/tmp/project-call-center-recording-test'
      : createHash('sha256').update('recording-test-key').digest('base64')),
  };

  it('accepts only compressed audio formats', () => {
    const service = new RecordingService({} as any, config as any, {} as any);
    expect(service.isAllowedMimeType('audio/mp4')).toBe(true);
    expect(service.isAllowedMimeType('audio/3gpp')).toBe(true);
    expect(service.isAllowedMimeType('audio/wav')).toBe(false);
  });

  it('maps recording metadata without exposing object paths', () => {
    const service = new RecordingService({} as any, config as any, {} as any);
    const result = service.metadata({
      id: 'recording-1',
      status: CallRecordingStatus.READY,
      mimeType: 'audio/mp4',
      sizeBytes: 123,
      durationSeconds: 7,
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
      uploadedAt: new Date('2026-08-13T00:00:01.000Z'),
      deletedAt: null,
    });
    expect(result).toEqual(expect.objectContaining({ id: 'recording-1', status: 'READY', sizeBytes: 123 }));
    expect(result).not.toHaveProperty('objectKey');
  });

  it('encrypts uploads, returns decrypted playback, and records the audit action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'call-recording-'));
    const prisma = {
      callRecording: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'recording-1',
          attemptId: 'attempt-1',
          agentId: 'agent-1',
          deviceId: 'device-1',
          status: CallRecordingStatus.PENDING,
          objectKey: null,
          mimeType: null,
          sizeBytes: null,
          durationSeconds: null,
          createdAt: new Date(),
          uploadedAt: null,
          deletedAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'recording-1',
          attemptId: 'attempt-1',
          agentId: 'agent-1',
          deviceId: 'device-1',
          status: data.status ?? CallRecordingStatus.READY,
          objectKey: data.objectKey ?? 'recordings/agent-1/attempt-1.m4a',
          mimeType: data.mimeType ?? 'audio/mp4',
          sizeBytes: data.sizeBytes ?? 5,
          durationSeconds: data.durationSeconds ?? 2,
          createdAt: new Date(),
          uploadedAt: new Date(),
          deletedAt: null,
        })),
      },
      mobileAppPolicy: { findUnique: jest.fn().mockResolvedValue({ recordingRetentionDays: 30 }) },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new RecordingService(prisma as any, { get: jest.fn((key: string) => key === 'RECORDINGS_DIR' ? root : createHash('sha256').update('recording-test-key').digest('base64')) } as any, audit as any);
    try {
      await service.upload('attempt-1', 'agent-1', 'device-1', { buffer: Buffer.from('hello'), mimetype: 'audio/mp4', durationSeconds: 2 });
      const encryptedPath = join(root, 'recordings', 'agent-1', 'attempt-1.m4a');
      expect((await readFile(encryptedPath)).toString()).not.toContain('hello');
      prisma.callRecording.findUnique.mockResolvedValueOnce({
        id: 'recording-1',
        attemptId: 'attempt-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
        status: CallRecordingStatus.READY,
        objectKey: 'recordings/agent-1/attempt-1.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 5,
        durationSeconds: 2,
        createdAt: new Date(),
        uploadedAt: new Date(),
        deletedAt: null,
      });
      const opened = await service.open('attempt-1', 'admin-1', false);
      expect(await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        opened.stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        opened.stream.on('end', () => resolve(Buffer.concat(chunks)));
        opened.stream.on('error', reject);
      })).toEqual(Buffer.from('hello'));
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CALL_RECORDING_PLAYED', actorId: 'admin-1' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a corrupt encrypted file with a controlled error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'call-recording-corrupt-'));
    const prisma = {
      callRecording: {
        findUnique: jest.fn().mockResolvedValue({ id: 'recording-1', status: CallRecordingStatus.READY, objectKey: 'recordings/corrupt.m4a', mimeType: 'audio/mp4', sizeBytes: 5, attemptId: 'attempt-1' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new RecordingService(prisma as any, { get: jest.fn((key: string) => key === 'RECORDINGS_DIR' ? root : createHash('sha256').update('recording-test-key').digest('base64')) } as any, { record: jest.fn() } as any);
    await mkdir(join(root, 'recordings'), { recursive: true });
    await writeFile(join(root, 'recordings', 'corrupt.m4a'), Buffer.from('corrupt'));
    try {
      await expect(service.open('attempt-1', 'admin-1', false)).rejects.toMatchObject({ response: { code: 'RECORDING_FILE_INVALID' } });
      expect(prisma.callRecording.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: CallRecordingStatus.FAILED, failureCode: 'FILE_INVALID' } }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes expired audio files while retaining a deleted metadata row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'call-recording-expired-'));
    const objectKey = 'recordings/agent-1/expired.m4a';
    const filePath = join(root, objectKey);
    const prisma = {
      callRecording: {
        findMany: jest.fn().mockResolvedValue([{ id: 'recording-1', objectKey, status: CallRecordingStatus.READY }]),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new RecordingService(prisma as any, { get: jest.fn((key: string) => key === 'RECORDINGS_DIR' ? root : createHash('sha256').update('recording-test-key').digest('base64')) } as any, audit as any);
    try {
      await mkdir(join(root, 'recordings', 'agent-1'), { recursive: true });
      await writeFile(filePath, Buffer.from('encrypted'));
      await expect(service.cleanupExpired()).resolves.toBe(1);
      await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(prisma.callRecording.update).toHaveBeenCalledWith({
        where: { id: 'recording-1' },
        data: expect.objectContaining({ status: CallRecordingStatus.DELETED }),
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CALL_RECORDINGS_CLEANED' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
