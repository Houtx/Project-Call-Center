import { Injectable } from '@nestjs/common';
import { find, type PhoneInfo } from 'phone2region';

export interface PhoneAttribution {
  province?: string;
  city?: string;
  carrier?: string;
}

const carrierNames: Record<string, string> = {
  '移动': '中国移动',
  '联通': '中国联通',
  '电信': '中国电信',
};

@Injectable()
export class PhoneAttributionService {
  lookup(normalizedPhone: string): PhoneAttribution | null {
    const nationalNumber = normalizedPhone.replace(/^\+86/, '');
    if (!/^1\d{10}$/.test(nationalNumber)) return null;

    let result: PhoneInfo;
    try {
      result = find(nationalNumber);
    } catch {
      return null;
    }
    const province = this.clean(result.province);
    const city = this.clean(result.city);
    const carrier = nationalNumber.startsWith('192')
      ? '中国广电'
      : carrierNames[result.op] ?? (result.op === '异常' ? undefined : this.clean(result.op));

    if (!province && !city && !carrier) return null;
    return { province, city, carrier };
  }

  private clean(value: string): string | undefined {
    return value.trim() || undefined;
  }
}
