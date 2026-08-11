import { AttemptStatus } from '@prisma/client';

export const DEFAULT_MAX_CALL_ATTEMPTS = 2;
export const MAX_CONFIGURABLE_CALL_ATTEMPTS = 10;
export const RETRY_INTERVAL_MS = 30 * 60 * 1000;

export type CallEligibility =
  | { allowed: true; attemptNumber: number }
  | { allowed: false; reason: 'ATTEMPT_LIMIT_REACHED' }
  | { allowed: false; reason: 'RETRY_INTERVAL_NOT_REACHED'; retryAt: Date };

export function callEligibility(
  previous: { initiatedAt: Date }[],
  maxAttempts = DEFAULT_MAX_CALL_ATTEMPTS,
  now = new Date(),
): CallEligibility {
  if (previous.length >= maxAttempts) {
    return { allowed: false, reason: 'ATTEMPT_LIMIT_REACHED' };
  }
  const latest = previous[0];
  if (latest) {
    const retryAt = new Date(latest.initiatedAt.getTime() + RETRY_INTERVAL_MS);
    if (retryAt > now) {
      return { allowed: false, reason: 'RETRY_INTERVAL_NOT_REACHED', retryAt };
    }
  }
  return { allowed: true, attemptNumber: previous.length + 1 };
}

export function classifyDuration(durationSeconds: number): AttemptStatus {
  return durationSeconds > 0
    ? AttemptStatus.CONNECTED
    : AttemptStatus.NOT_CONNECTED;
}
