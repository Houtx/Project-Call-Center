import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface AttemptBucket {
  failures: number[];
}

@Injectable()
export class LoginRateLimitService {
  private readonly buckets = new Map<string, AttemptBucket>();

  assertAllowed(clientIp: string, username: string, now = Date.now()): void {
    const identity = this.normalizeUsername(username);
    const ipRetry = this.retryAfter(`ip:${clientIp}`, IP_LIMIT, IP_WINDOW_MS, now);
    const userRetry = this.retryAfter(`user:${identity}`, USER_LIMIT, USER_WINDOW_MS, now);
    const retryAfterSeconds = Math.max(ipRetry, userRetry);
    if (retryAfterSeconds > 0) {
      throw new HttpException({
        code: 'LOGIN_RATE_LIMITED',
        detail: `登录失败次数过多，请在 ${retryAfterSeconds} 秒后重试`,
        retryAfterSeconds,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(clientIp: string, username: string, now = Date.now()): void {
    this.pruneIfNeeded(now);
    this.addFailure(`ip:${clientIp}`, IP_WINDOW_MS, now);
    this.addFailure(`user:${this.normalizeUsername(username)}`, USER_WINDOW_MS, now);
  }

  recordSuccess(username: string): void {
    this.buckets.delete(`user:${this.normalizeUsername(username)}`);
  }

  private retryAfter(key: string, limit: number, windowMs: number, now: number): number {
    const failures = this.activeFailures(key, windowMs, now);
    if (failures.length < limit) return 0;
    return Math.max(1, Math.ceil((failures[0] + windowMs - now) / 1000));
  }

  private addFailure(key: string, windowMs: number, now: number): void {
    const failures = this.activeFailures(key, windowMs, now);
    failures.push(now);
    this.buckets.set(key, { failures });
  }

  private activeFailures(key: string, windowMs: number, now: number): number[] {
    const bucket = this.buckets.get(key);
    if (!bucket) return [];
    const cutoff = now - windowMs;
    bucket.failures = bucket.failures.filter((failureAt) => failureAt > cutoff);
    if (!bucket.failures.length) this.buckets.delete(key);
    return bucket.failures;
  }

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private pruneIfNeeded(now: number): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    for (const [key] of this.buckets) {
      const windowMs = key.startsWith('ip:') ? IP_WINDOW_MS : USER_WINDOW_MS;
      this.activeFailures(key, windowMs, now);
    }
    while (this.buckets.size >= MAX_BUCKETS) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

const IP_LIMIT = 20;
const IP_WINDOW_MS = 5 * 60 * 1000;
const USER_LIMIT = 8;
const USER_WINDOW_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 10_000;
