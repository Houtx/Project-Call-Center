import { CallRecordingStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
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
});
