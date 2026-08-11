import { PhoneAttributionService } from './phone-attribution.service';

describe('PhoneAttributionService', () => {
  const service = new PhoneAttributionService();

  it('looks up a Chinese mobile number without network access', () => {
    expect(service.lookup('+8613800001001')).toEqual({
      province: '北京',
      city: '北京',
      carrier: '中国移动',
    });
  });

  it('recognizes the China Broadnet 192 range', () => {
    expect(service.lookup('+8619200000000')).toEqual(expect.objectContaining({
      carrier: '中国广电',
    }));
  });

  it('ignores unsupported numbers', () => {
    expect(service.lookup('+12025550123')).toBeNull();
  });
});
