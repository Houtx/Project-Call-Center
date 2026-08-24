const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function duration(seconds) {
  const value = Math.round(Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${hours} 小时 ${minutes} 分` : minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

function metric(label, value, note) {
  const node = document.createElement('article');
  node.className = 'metric-card';
  const title = document.createElement('span');
  const strong = document.createElement('strong');
  const small = document.createElement('small');
  title.textContent = label;
  strong.textContent = value;
  small.textContent = note;
  node.append(title, strong, small);
  return node;
}

function renderMetrics(data) {
  const m = data.metrics;
  const values = [
    ['今日活跃安装', number.format(m.activeToday), '已启用匿名统计'],
    [`近 ${data.rangeDays} 天活跃`, number.format(m.activeRange), `观测安装 ${number.format(m.observedInstallations)}`],
    ['外呼总量', number.format(m.callCount), `接通 ${number.format(m.connectedCount)} · 未接 ${number.format(m.notConnectedCount)}`],
    ['接通率', `${(m.connectionRate * 100).toFixed(1)}%`, `未知 ${number.format(m.unknownCount)} 通不计入分母`],
    ['总通话时长', duration(m.totalDurationSeconds), '仅汇总已接通通话'],
    ['平均通话时长', duration(m.averageDurationSeconds), '按接通通话计算'],
    ['来源 IP 数', number.format(m.ipCount), 'IP 仅保存 HMAC 与脱敏网段'],
    ['明细保留', `${data.retentionDays} 天`, '汇总数据长期保留'],
  ];
  byId('metrics').replaceChildren(...values.map((item) => metric(...item)));
}

function renderTrend(rows) {
  const maximum = Math.max(1, ...rows.map((row) => row.calls));
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const width = Math.max(720, rows.length * 22);
  const labelCount = Math.min(10, rows.length);
  const labelIndexes = new Set(Array.from({ length: labelCount }, (_, index) => (
    labelCount === 1 ? 0 : Math.round(index * (rows.length - 1) / (labelCount - 1))
  )));
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('trend-svg');
  svg.setAttribute('viewBox', `0 0 ${width} 210`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const axis = document.createElementNS(svgNamespace, 'line');
  axis.classList.add('axis');
  axis.setAttribute('x1', '0');
  axis.setAttribute('x2', String(width));
  axis.setAttribute('y1', '184');
  axis.setAttribute('y2', '184');
  svg.append(axis);
  rows.forEach((row, index) => {
    const slot = width / Math.max(1, rows.length);
    const height = Math.max(2, Math.round((row.calls / maximum) * 156));
    const bar = document.createElementNS(svgNamespace, 'rect');
    bar.classList.add('bar');
    bar.setAttribute('x', String(index * slot + slot * .15));
    bar.setAttribute('y', String(184 - height));
    bar.setAttribute('width', String(slot * .7));
    bar.setAttribute('height', String(height));
    const title = document.createElementNS(svgNamespace, 'title');
    title.textContent = `${row.date}：外呼 ${row.calls}，接通 ${row.connected}，活跃安装 ${row.installations}`;
    bar.append(title);
    svg.append(bar);
    if (labelIndexes.has(index)) {
      const label = document.createElementNS(svgNamespace, 'text');
      label.setAttribute('x', String(index * slot + slot / 2));
      label.setAttribute('y', '202');
      label.setAttribute('text-anchor', index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle');
      label.textContent = row.date.slice(5);
      svg.append(label);
    }
  });
  byId('trend').replaceChildren(svg);
}

const countryNames = { CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', SG: '新加坡', MY: '马来西亚', ZZ: '未知' };
function renderBars(id, rows, formatter = (value) => String(value)) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  const nodes = rows.length ? rows.map((row) => {
    const node = document.createElement('div');
    node.className = 'bar-row';
    const label = document.createElement('span');
    label.textContent = formatter(row.label);
    label.title = label.textContent;
    const track = document.createElement('progress');
    track.max = maximum;
    track.value = row.value;
    track.setAttribute('aria-label', `${label.textContent} ${row.value}`);
    const value = document.createElement('strong');
    value.textContent = number.format(row.value);
    node.append(label, track, value);
    return node;
  }) : [Object.assign(document.createElement('p'), { className: 'muted', textContent: '暂无数据' })];
  byId(id).replaceChildren(...nodes);
}

function renderRecent(rows) {
  const nodes = rows.map((row) => {
    const tr = document.createElement('tr');
    const values = [
      dateTime.format(new Date(row.last_seen_at)),
      row.installation,
      row.mode === 'offline' ? '离线' : '在线',
      row.app_version,
      `API ${row.android_api}`,
      `${countryNames[row.country_code] || row.country_code} / ${row.timezone}`,
      row.ip_masked,
    ];
    values.forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (index === 2) td.className = 'mode-tag';
      tr.append(td);
    });
    return tr;
  });
  if (!nodes.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = '暂无已启用统计的活跃安装';
    tr.append(td);
    nodes.push(tr);
  }
  byId('recent').replaceChildren(...nodes);
}

async function load() {
  byId('loading').hidden = false;
  byId('error').hidden = true;
  try {
    const response = await fetch(`/admin/api/dashboard?days=${byId('range').value}`, { credentials: 'same-origin' });
    if (response.status === 401) { location.href = '/login'; return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    byId('notice').textContent = data.notice;
    byId('updated-at').textContent = `更新于 ${dateTime.format(new Date(data.generatedAt))}`;
    renderMetrics(data);
    renderTrend(data.trend);
    renderBars('versions', data.dimensions.versions);
    renderBars('android', data.dimensions.androidVersions, (value) => `Android API ${value}`);
    renderBars('modes', data.dimensions.modes, (value) => value === 'offline' ? '离线模式' : '在线模式');
    renderBars('countries', data.dimensions.countries, (value) => countryNames[value] || value);
    renderBars('timezones', data.dimensions.timezones);
    renderRecent(data.recent);
  } catch (error) {
    byId('error').textContent = `统计加载失败：${error.message}`;
    byId('error').hidden = false;
  } finally {
    byId('loading').hidden = true;
  }
}

const releaseTagPattern = /^v[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const packageNamePattern = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const apkAssetPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,191}\.apk$/i;

function parseReleaseManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.versionCode) ||
    value.versionCode < 1 ||
    typeof value.versionName !== 'string' ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/.test(value.versionName) ||
    typeof value.releaseTag !== 'string' ||
    !releaseTagPattern.test(value.releaseTag) ||
    typeof value.packageName !== 'string' ||
    !packageNamePattern.test(value.packageName) ||
    typeof value.apkAsset !== 'string' ||
    !apkAssetPattern.test(value.apkAsset) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > 500 * 1024 * 1024
  ) {
    throw new Error('最新版本清单内容无效');
  }
  const path = `/releases/${encodeURIComponent(value.releaseTag)}/${encodeURIComponent(value.apkAsset)}`;
  const downloadUrl = new URL(path, location.origin);
  if (downloadUrl.origin !== location.origin || !downloadUrl.pathname.endsWith('.apk')) {
    throw new Error('安装包下载地址无效');
  }
  return { ...value, downloadUrl: downloadUrl.href };
}

function renderDownloadQr(downloadUrl) {
  if (typeof globalThis.qrcode !== 'function') throw new Error('二维码组件加载失败');
  const code = globalThis.qrcode(0, 'M');
  code.addData(downloadUrl);
  code.make();
  const quietZone = 4;
  const moduleCount = code.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '最新 APK 下载二维码');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const title = document.createElementNS(svgNamespace, 'title');
  title.textContent = '最新 APK 下载二维码';
  const background = document.createElementNS(svgNamespace, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const modules = document.createElementNS(svgNamespace, 'path');
  const path = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (code.isDark(row, column)) path.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
    }
  }
  modules.setAttribute('d', path.join(''));
  modules.setAttribute('fill', '#111');
  svg.append(title, background, modules);
  byId('apk-qr').replaceChildren(svg);
}

const apkDialog = byId('apk-dialog');
const apkLoading = byId('apk-loading');
const apkContent = byId('apk-content');
const apkError = byId('apk-error');

async function loadLatestApk() {
  apkLoading.hidden = false;
  apkContent.hidden = true;
  apkError.hidden = true;
  try {
    const response = await fetch('/release.json', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`读取最新版本失败（HTTP ${response.status}）`);
    const release = parseReleaseManifest(await response.json());
    renderDownloadQr(release.downloadUrl);
    byId('apk-version').textContent = `${release.versionName}（版本号 ${release.versionCode}）`;
    byId('apk-filename').textContent = release.apkAsset;
    byId('apk-size').textContent = `${(release.sizeBytes / 1024 / 1024).toFixed(2)} MB`;
    const download = byId('apk-download');
    download.href = release.downloadUrl;
    download.download = release.apkAsset;
    apkContent.hidden = false;
  } catch (error) {
    byId('apk-error-message').textContent = error.message || '读取最新版本失败';
    apkError.hidden = false;
  } finally {
    apkLoading.hidden = true;
  }
}

byId('apk-open').addEventListener('click', () => {
  apkDialog.showModal();
  loadLatestApk();
});
byId('apk-retry').addEventListener('click', loadLatestApk);
document.querySelectorAll('.apk-close').forEach((button) => {
  button.addEventListener('click', () => apkDialog.close());
});
apkDialog.addEventListener('click', (event) => {
  if (event.target === apkDialog) apkDialog.close();
});

const passwordDialog = byId('password-dialog');
const passwordForm = byId('password-form');
const passwordError = byId('password-error');
const passwordSubmit = byId('password-submit');

function showPasswordError(message) {
  passwordError.textContent = message;
  passwordError.hidden = false;
}

byId('password-open').addEventListener('click', () => {
  passwordForm.reset();
  passwordError.hidden = true;
  passwordDialog.showModal();
  byId('current-password').focus();
});
byId('password-cancel').addEventListener('click', () => passwordDialog.close());
passwordDialog.addEventListener('click', (event) => {
  if (event.target === passwordDialog) passwordDialog.close();
});
passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordError.hidden = true;
  if (byId('new-password').value !== byId('confirm-password').value) {
    showPasswordError('两次输入的新密码不一致');
    return;
  }
  passwordSubmit.disabled = true;
  try {
    const response = await fetch('/admin/api/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(new FormData(passwordForm)),
    });
    if (response.status === 401) { location.href = '/login'; return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    location.reload();
  } catch (error) {
    showPasswordError(error.message);
  } finally {
    passwordSubmit.disabled = false;
  }
});

byId('range').addEventListener('change', load);
byId('refresh').addEventListener('click', load);
load();
