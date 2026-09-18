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
const announcements = {
  items: [{
    id: 3,
    title: '服务通知',
    content: '请所有坐席阅读。',
    publishedAt: '2026-08-20T05:00:00Z',
    revision: 2,
    updatedAt: '2026-08-20T06:00:00Z',
    active: true,
  }],
};

const styledHtml = html.replace('<link rel="stylesheet" href="/assets/app.css">', `<style>${css}</style>`);
const dom = new JSDOM(styledHtml, { runScripts: 'outside-only', url: 'https://call.example.test/admin' });
const fetchCalls = [];
dom.window.confirm = () => true;
dom.window.fetch = async (url, options = {}) => {
  fetchCalls.push({ url, options });
  if (url === '/admin/api/announcements' && options.method === 'POST') {
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: 4,
        title: options.body.get('title'),
        content: options.body.get('content'),
        publishedAt: '2026-08-21T05:00:00Z',
        revision: 1,
        updatedAt: '2026-08-21T05:00:00Z',
        active: true,
      }),
    };
  }
  if (url === '/admin/api/announcements/3' && options.method === 'PUT') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...announcements.items[0],
        title: options.body.get('title'),
        content: options.body.get('content'),
        revision: 3,
      }),
    };
  }
  if (url === '/admin/api/announcements/3' && options.method === 'DELETE') {
    return { ok: true, status: 200, json: async () => ({ deleted: true, id: 3 }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => url === '/release.json'
      ? release
      : url === '/admin/api/announcements'
        ? announcements
        : sample,
  };
};
const dashboardFetch = dom.window.fetch;
dom.window.eval(qrScript);
dom.window.eval(script);
await new Promise((resolve) => setTimeout(resolve, 0));

const convertedShanghai = dom.window.eval('wgs84ToGcj02(31.230416, 121.473701)');
assert.ok(convertedShanghai[0] < 31.230416 - 0.001);
assert.ok(convertedShanghai[1] > 121.473701 + 0.001);
const roundTripShanghai = dom.window.eval(`gcj02ToWgs84(${convertedShanghai[0]}, ${convertedShanghai[1]})`);
assert.ok(Math.abs(roundTripShanghai[0] - 31.230416) < 0.0001);
assert.ok(Math.abs(roundTripShanghai[1] - 121.473701) < 0.0001);

const document = dom.window.document;
assert.equal(document.querySelectorAll('.metric-card').length, 8);
assert.equal(document.querySelectorAll('.section-nav a').length, 5);
assert.equal(document.querySelectorAll('.trend-svg rect.bar').length, 30);
assert.equal(document.querySelectorAll('.trend-svg rect.bar-connected').length, 30);
assert.equal(document.querySelectorAll('.trend-svg .gridline').length, 5);
assert.equal(document.querySelectorAll('.trend-svg .date-label').length, 10);
assert.equal(document.querySelector('.trend-svg .date-label').textContent, '07-01');
assert.equal(document.querySelector('.trend-svg .date-label:last-child').textContent, '07-30');
assert.equal(document.querySelectorAll('.bar-row .bar-fill').length, 5);
assert.equal(document.querySelectorAll('#recent tr').length, 1);
assert.equal(document.querySelectorAll('#recent tr:first-child td').length, 7);
assert.equal(document.querySelector('#recent .mode-tag').parentElement.tagName, 'TD');
assert.match(document.querySelector('#metrics').textContent, /外呼总量/);
assert.match(document.querySelector('#recent').textContent, /203\.0\.113\.\*/);
assert.equal(document.querySelector('#error').hidden, true);
assert.equal(document.querySelector('#loading').hidden, true);
assert.equal(dom.window.getComputedStyle(document.querySelector('#loading')).display, 'none');
assert.equal(document.querySelector('#password-open').textContent, '修改密码');
assert.equal(document.querySelectorAll('#password-dialog input[type="password"]').length, 3);
assert.equal(document.querySelector('#apk-open').textContent, '下载最新 APK');
assert.equal(document.querySelector('#announcement-submit').textContent, '发布新公告');
assert.equal(document.querySelectorAll('#announcements .announcement-item').length, 1);
assert.match(document.querySelector('#announcements').textContent, /服务通知/);
assert.match(document.querySelector('#announcements').textContent, /请所有坐席阅读/);
assert.equal(document.querySelector('.announcement-status-tag').textContent, '当前');
assert.equal(document.querySelectorAll('.announcement-actions button').length, 2);
assert.match(document.querySelector('#announcement-summary').textContent, /当前公告 #3/);
assert.equal(document.querySelectorAll('#map-metric option').length, 7);
assert.equal(document.querySelector('#map-metric').value, 'devices');
assert.equal(document.querySelector('#map-error').hidden, false);
assert.match(document.querySelector('#map-error').textContent, /地图组件加载失败/);

const trendBar = document.querySelector('.trend-svg .day-group');
assert.equal(trendBar.getAttribute('tabindex'), '0');
assert.match(trendBar.getAttribute('aria-label'), /外呼总量 0/);
trendBar.dispatchEvent(new dom.window.Event('pointerenter', { bubbles: true }));
assert.equal(document.querySelector('#chart-tooltip').hidden, false);
assert.match(document.querySelector('#chart-tooltip').textContent, /2026-07-01/);
assert.match(document.querySelector('#chart-tooltip').textContent, /外呼总量：0/);
trendBar.dispatchEvent(new dom.window.Event('pointerleave', { bubbles: true }));
assert.equal(document.querySelector('#chart-tooltip').hidden, true);

const dimensionBar = document.querySelector('.bar-row');
assert.equal(dimensionBar.getAttribute('tabindex'), '0');
assert.match(dimensionBar.getAttribute('aria-label'), /占比 100\.0%/);
dimensionBar.dispatchEvent(new dom.window.Event('pointerenter', { bubbles: true }));
assert.equal(document.querySelector('#chart-tooltip').hidden, false);
assert.match(document.querySelector('#chart-tooltip').textContent, /0\.6\.6/);
assert.match(document.querySelector('#chart-tooltip').textContent, /占该分类总量：100\.0%/);
dimensionBar.dispatchEvent(new dom.window.Event('pointerleave', { bubbles: true }));
assert.equal(document.querySelector('#chart-tooltip').hidden, true);

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
dom.window.fetch = dashboardFetch;

document.querySelector('#new-password').value = 'replacement password';
document.querySelector('#confirm-password').value = 'different password';
document.querySelector('#password-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(document.querySelector('#password-error').textContent, '两次输入的新密码不一致');
assert.equal(document.querySelector('#password-error').hidden, false);
document.querySelector('#announcement-title').value = '版本更新';
document.querySelector('#announcement-content').value = '请重新启动 APP。';
document.querySelector('#announcement-form').dispatchEvent(new dom.window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(document.querySelector('#announcement-status').textContent, '公告 #4 已发布');
assert.equal(document.querySelector('#announcement-submit').disabled, false);
const announcementRequest = fetchCalls.find((call) => call.options.method === 'POST');
assert.equal(announcementRequest.url, '/admin/api/announcements');
assert.equal(announcementRequest.options.credentials, 'same-origin');
assert.equal(announcementRequest.options.body.get('csrf'), '__CSRF_TOKEN__');
assert.equal(announcementRequest.options.body.get('title'), '版本更新');
assert.equal(announcementRequest.options.body.get('content'), '请重新启动 APP。');

const editDialog = document.querySelector('#announcement-edit-dialog');
editDialog.showModal = () => { editDialog.open = true; };
editDialog.close = () => { editDialog.open = false; };
document.querySelector('.announcement-actions button.secondary').click();
assert.equal(editDialog.open, true);
assert.equal(document.querySelector('#announcement-edit-title').value, '服务通知');
assert.equal(document.querySelector('#announcement-edit-content').value, '请所有坐席阅读。');
assert.match(document.querySelector('#announcement-edit-note').textContent, /再次弹出/);
document.querySelector('#announcement-edit-title').value = '服务通知（修订）';
document.querySelector('#announcement-edit-content').value = '请重新阅读。';
document.querySelector('#announcement-edit-form').dispatchEvent(new dom.window.Event('submit', {
  bubbles: true,
  cancelable: true,
}));
await new Promise((resolve) => setTimeout(resolve, 0));
const editRequest = fetchCalls.find((call) => call.options.method === 'PUT');
assert.equal(editRequest.url, '/admin/api/announcements/3');
assert.equal(editRequest.options.credentials, 'same-origin');
assert.equal(editRequest.options.body.get('csrf'), '__CSRF_TOKEN__');
assert.equal(editRequest.options.body.get('title'), '服务通知（修订）');
assert.equal(editRequest.options.body.get('content'), '请重新阅读。');
assert.equal(editDialog.open, false);

document.querySelector('.announcement-actions button.danger').click();
await new Promise((resolve) => setTimeout(resolve, 0));
const deleteRequest = fetchCalls.find((call) => call.options.method === 'DELETE');
assert.equal(deleteRequest.url, '/admin/api/announcements/3');
assert.equal(deleteRequest.options.credentials, 'same-origin');
assert.equal(deleteRequest.options.body.get('csrf'), '__CSRF_TOKEN__');
assert.equal(document.querySelector('#announcement-status').textContent, '公告 #3 已删除');
assert.deepEqual(fetchCalls.slice(0, 3).map((call) => call.url), [
  '/admin/api/dashboard?days=30',
  '/admin/api/announcements',
  '/release.json',
]);

console.log('Dashboard DOM rendering passed');
