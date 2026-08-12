import { HttpStatus } from '@nestjs/common';
import { LoginRateLimitService } from './login-rate-limit.service';

describe('LoginRateLimitService', () => {
  it('blocks a username after eight invalid passwords and clears it after success', () => {
    const limiter = new LoginRateLimitService();
    const now = Date.parse('2026-08-12T08:00:00.000Z');
    for (let index = 0; index < 8; index += 1) {
      limiter.assertAllowed(`10.0.0.${index + 1}`, 'Agent001', now);
      limiter.recordFailure(`10.0.0.${index + 1}`, 'Agent001', now);
    }

    expect(() => limiter.assertAllowed('10.0.0.99', 'agent001', now)).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
    limiter.recordSuccess('AGENT001');
    expect(() => limiter.assertAllowed('10.0.0.99', 'agent001', now)).not.toThrow();
  });

  it('blocks an address that attacks multiple usernames', () => {
    const limiter = new LoginRateLimitService();
    const now = Date.parse('2026-08-12T08:00:00.000Z');
    for (let index = 0; index < 20; index += 1) {
      limiter.recordFailure('10.0.0.1', `agent${index}`, now);
    }
    expect(() => limiter.assertAllowed('10.0.0.1', 'another-agent', now)).toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });
});
