import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('./static/dashboard.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./static/app.css', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('./static/dashboard.js', import.meta.url), 'utf8');
const sample = {
  generatedAt: '2026-08-20T05:00:00Z',
  rangeDays: 30,
  retentionDays: 30,
  metrics: {
    activeToday: 3,
    activeRange: 9,
    observedInstallations: 12,
    ipCount: 4,
    callCount: 20,
    connectedCount: 8,
    notConnectedCount: 10,
    unknownCount: 2,
    connectionRate: 8 / 18,
    totalDurationSeconds: 600,
    averageDurationSeconds: 75,
  },
  trend: [
    { date: '2026-08-19', installations: 2, calls: 8, connected: 3 },
    { date: '2026-08-20', installations: 3, calls: 12, connected: 5 },
  ],
  dimensions: {
    versions: [{ label: '0.6.6', value: 3 }],
    androidVersions: [{ label: 35, value: 3 }],
    modes: [{ label: 'offline', value: 3 }],
    countries: [{ label: 'CN', value: 3 }],
    timezones: [{ label: 'Asia/Shanghai', value: 3 }],
  },
  recent: [{
    installation: 'a1b2c3d4e5',
    last_seen_at: '2026-08-20T05:00:00Z',
    app_version: '0.6.6',
    android_api: 35,
    mode: 'offline',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    country_code: 'CN',
    ip_masked: '203.0.113.*',
  }],
  notice: '仅统计主动开启匿名使用统计的安装。',
};

const styledHtml = html.replace('<link rel="stylesheet" href="/assets/app.css">', `<style>${css}</style>`);
const dom = new JSDOM(styledHtml, { runScripts: 'outside-only', url: 'https://call.example.test/admin' });
dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => sample });
dom.window.eval(script);
await new Promise((resolve) => setTimeout(resolve, 0));

const document = dom.window.document;
assert.equal(document.querySelectorAll('.metric-card').length, 8);
assert.equal(document.querySelectorAll('.trend-svg rect.bar').length, 2);
assert.equal(document.querySelectorAll('.bar-row progress').length, 5);
assert.equal(document.querySelectorAll('#recent tr').length, 1);
assert.match(document.querySelector('#metrics').textContent, /外呼总量/);
assert.match(document.querySelector('#recent').textContent, /203\.0\.113\.\*/);
assert.equal(document.querySelector('#error').hidden, true);
assert.equal(document.querySelector('#loading').hidden, true);
assert.equal(dom.window.getComputedStyle(document.querySelector('#loading')).display, 'none');

console.log('Dashboard DOM rendering passed');
