import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const service = new CryptoService({
    get: jest.fn((name: string) =>
      name === 'PHONE_ENCRYPTION_KEY' || name === 'PHONE_HASH_KEY' ? key : undefined,
    ),
  } as any);

  it('normalizes, masks and round-trips an encrypted CN phone', () => {
    const phone = service.normalizePhone('138 0000 0001');
    expect(phone).toBe('+8613800000001');
    expect(service.maskPhone(phone)).toBe('138****0001');
    expect(service.decryptPhone(service.encryptPhone(phone))).toBe(phone);
  });

  it('produces a stable search hash without exposing the phone', () => {
    const phone = '+8613800000001';
    expect(service.hashPhone(phone)).toBe(service.hashPhone(phone));
    expect(service.hashPhone(phone)).not.toContain('13800000001');
  });
});
