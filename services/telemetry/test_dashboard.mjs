import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('./static/dashboard.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./static/app.css', import.meta.url), 'utf8');
const qrScript = fs.readFileSync(new URL('./static/qrcode.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('./static/dashboard.js', import.meta.url), 'utf8');
const trend = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  installations: index % 4,
  calls: index,
  connected: Math.floor(index / 2),
}));
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
  trend,
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
  notice: '仅统计当前已启用匿名使用统计的安装。',
};
const release = {
  schemaVersion: 1,
  versionCode: 16,
  versionName: '0.7.0',
  releaseTag: 'v0.7.0',
  packageName: 'com.company.callcenter',
  apkAsset: 'project-call-center-agent-v0.7.0.apk',
  sha256: '33de6f5ed45d78a0db138065abcb09b641ca65ac5a29aaef0b3c18af7cb8fd66',
  sizeBytes: 2228562,
};

const styledHtml = html.replace('<link rel="stylesheet" href="/assets/app.css">', `<style>${css}</style>`);
const dom = new JSDOM(styledHtml, { runScripts: 'outside-only', url: 'https://call.example.test/admin' });
const fetchCalls = [];
dom.window.fetch = async (url) => {
  fetchCalls.push(url);
  return { ok: true, status: 200, json: async () => url === '/release.json' ? release : sample };
};
dom.window.eval(qrScript);
dom.window.eval(script);
await new Promise((resolve) => setTimeout(resolve, 0));

const document = dom.window.document;
assert.equal(document.querySelectorAll('.metric-card').length, 8);
assert.equal(document.querySelectorAll('.trend-svg rect.bar').length, 30);
assert.equal(document.querySelectorAll('.trend-svg text').length, 10);
assert.equal(document.querySelector('.trend-svg text').textContent, '07-01');
assert.equal(document.querySelector('.trend-svg text:last-child').textContent, '07-30');
assert.equal(document.querySelectorAll('.bar-row progress').length, 5);
assert.equal(document.querySelectorAll('#recent tr').length, 1);
assert.match(document.querySelector('#metrics').textContent, /外呼总量/);
assert.match(document.querySelector('#recent').textContent, /203\.0\.113\.\*/);
assert.equal(document.querySelector('#error').hidden, true);
assert.equal(document.querySelector('#loading').hidden, true);
assert.equal(dom.window.getComputedStyle(document.querySelector('#loading')).display, 'none');
assert.equal(document.querySelector('#password-open').textContent, '修改密码');
assert.equal(document.querySelectorAll('#password-dialog input[type="password"]').length, 3);
assert.equal(document.querySelector('#apk-open').textContent, '下载最新 APK');

const apkDialog = document.querySelector('#apk-dialog');
apkDialog.showModal = () => { apkDialog.open = true; };
apkDialog.close = () => { apkDialog.open = false; };
document.querySelector('#apk-open').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(apkDialog.open, true);
assert.equal(document.querySelector('#apk-loading').hidden, true);
assert.equal(document.querySelector('#apk-content').hidden, false);
assert.equal(document.querySelector('#apk-error').hidden, true);
assert.equal(document.querySelector('#apk-version').textContent, '0.7.0（版本号 16）');
assert.equal(document.querySelector('#apk-filename').textContent, 'project-call-center-agent-v0.7.0.apk');
assert.equal(document.querySelector('#apk-size').textContent, '2.13 MB');
assert.equal(
  document.querySelector('#apk-download').href,
  'https://call.example.test/releases/v0.7.0/project-call-center-agent-v0.7.0.apk',
);
assert.ok(document.querySelector('#apk-qr svg path').getAttribute('d').length > 100);

dom.window.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ...release, releaseTag: '../private' }),
});
document.querySelector('#apk-retry').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(document.querySelector('#apk-content').hidden, true);
assert.equal(document.querySelector('#apk-error').hidden, false);
assert.equal(document.querySelector('#apk-error-message').textContent, '最新版本清单内容无效');

document.querySelector('#new-password').value = 'replacement password';
document.querySelector('#confirm-password').value = 'different password';
document.querySelector('#password-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(document.querySelector('#password-error').textContent, '两次输入的新密码不一致');
assert.equal(document.querySelector('#password-error').hidden, false);
assert.deepEqual(fetchCalls, ['/admin/api/dashboard?days=30', '/release.json']);

console.log('Dashboard DOM rendering passed');
