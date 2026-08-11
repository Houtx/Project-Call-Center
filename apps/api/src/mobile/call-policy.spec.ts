import { AttemptStatus } from '@prisma/client';
import { callEligibility, classifyDuration } from './call-policy';

describe('call policy', () => {
  const now = new Date('2026-08-05T00:00:00.000Z');

  it('allows a first call and classifies durations', () => {
    expect(callEligibility([], 2, now)).toEqual({ allowed: true, attemptNumber: 1 });
    expect(classifyDuration(1)).toBe(AttemptStatus.CONNECTED);
    expect(classifyDuration(0)).toBe(AttemptStatus.NOT_CONNECTED);
  });

  it('blocks a retry before 30 minutes', () => {
    const result = callEligibility(
      [{ initiatedAt: new Date(now.getTime() - 29 * 60_000) }],
      2,
      now,
    );
    expect(result).toMatchObject({ allowed: false, reason: 'RETRY_INTERVAL_NOT_REACHED' });
  });

  it('allows a retry at 30 minutes and blocks a third attempt by default', () => {
    expect(callEligibility([{ initiatedAt: new Date(now.getTime() - 30 * 60_000) }], 2, now))
      .toEqual({ allowed: true, attemptNumber: 2 });
    expect(callEligibility([
      { initiatedAt: new Date(now.getTime() - 30 * 60_000) },
      { initiatedAt: new Date(now.getTime() - 60 * 60_000) },
    ], 2, now)).toEqual({ allowed: false, reason: 'ATTEMPT_LIMIT_REACHED' });
  });

  it('uses an administrator-configured higher attempt limit', () => {
    expect(callEligibility([
      { initiatedAt: new Date(now.getTime() - 30 * 60_000) },
      { initiatedAt: new Date(now.getTime() - 60 * 60_000) },
    ], 4, now)).toEqual({ allowed: true, attemptNumber: 3 });
  });
});
