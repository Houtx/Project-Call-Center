import { describe, expect, it } from 'vitest';
import { formatDuration, formatPercent } from './format';

describe('report formatting', () => {
  it('formats zero-second and long calls without hiding valid zero values', () => {
    expect(formatDuration(0)).toBe('0秒');
    expect(formatDuration(65)).toBe('1分5秒');
    expect(formatDuration(3_661)).toBe('1时1分1秒');
    expect(formatDuration(null)).toBe('-');
  });

  it('renders backend rate decimals as percentages', () => {
    expect(formatPercent(0.9876)).toBe('98.8%');
    expect(formatPercent(0)).toBe('0.0%');
  });
});
