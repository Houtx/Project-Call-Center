import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(config: ConfigService) {
    this.encryptionKey = this.readKey(config.get<string>('PHONE_ENCRYPTION_KEY'));
    this.hashKey = this.readKey(config.get<string>('PHONE_HASH_KEY'));
  }

  normalizePhone(input: string): string {
    const trimmed = input.trim().replace(/[\s()-]/g, '');
    const parsed = parsePhoneNumberFromString(trimmed, 'CN');
    if (!parsed?.isValid()) {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        detail: '联系号码格式无效',
      });
    }
    return parsed.number;
  }

  hashPhone(normalizedPhone: string): string {
    return createHmac('sha256', this.hashKey)
      .update(normalizedPhone)
      .digest('hex');
  }

  encryptPhone(normalizedPhone: string): {
    phoneCiphertext: Uint8Array<ArrayBuffer>;
    phoneIv: Uint8Array<ArrayBuffer>;
    phoneTag: Uint8Array<ArrayBuffer>;
  } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(normalizedPhone, 'utf8'),
      cipher.final(),
    ]);
    return {
      phoneCiphertext: new Uint8Array(encrypted),
      phoneIv: new Uint8Array(iv),
      phoneTag: new Uint8Array(cipher.getAuthTag()),
    };
  }

  decryptPhone(payload: {
    phoneCiphertext: Uint8Array;
    phoneIv: Uint8Array;
    phoneTag: Uint8Array;
  }): string {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(payload.phoneIv),
      );
      decipher.setAuthTag(Buffer.from(payload.phoneTag));
      return Buffer.concat([
        decipher.update(Buffer.from(payload.phoneCiphertext)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException({
        code: 'PHONE_DECRYPTION_FAILED',
        detail: '号码密文无法解密',
      });
    }
  }

  maskPhone(normalizedPhone: string): string {
    const digits = normalizedPhone.replace(/^\+86/, '');
    if (digits.length < 7) return `${digits.slice(0, 2)}****`;
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  }

  private readKey(value?: string): Buffer {
    if (!value) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Phone encryption keys are required in production');
      }
      return createHmac('sha256', 'development-only')
        .update('call-center-local-key')
        .digest();
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32) {
      throw new Error('Phone encryption keys must be base64-encoded 32 byte keys');
    }
    return decoded;
  }
}
