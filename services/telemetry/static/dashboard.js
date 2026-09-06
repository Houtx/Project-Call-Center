const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const chartTooltip = byId('chart-tooltip');

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positionChartTooltip(clientX, clientY, anchor) {
  const margin = 12;
  const gap = 14;
  const tooltipRect = chartTooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const anchorRect = anchor?.getBoundingClientRect?.();
  const hasPointerPosition = Number.isFinite(clientX) && Number.isFinite(clientY);
  let left = hasPointerPosition
    ? clientX + gap
    : (anchorRect ? anchorRect.left + anchorRect.width / 2 : margin);
  let top = hasPointerPosition
    ? clientY + gap
    : (anchorRect ? anchorRect.top : margin);

  if (left + tooltipRect.width + margin > viewportWidth) {
    left = Math.max(margin, viewportWidth - tooltipRect.width - margin);
  }
  if (top + tooltipRect.height + margin > viewportHeight) {
    top = Math.max(margin, top - tooltipRect.height - gap);
  }
  chartTooltip.style.left = `${Math.round(Math.max(margin, left))}px`;
  chartTooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function showChartTooltip(lines, event, anchor) {
  chartTooltip.textContent = lines.join('\n');
  chartTooltip.hidden = false;
  positionChartTooltip(event?.clientX, event?.clientY, anchor);
}

function hideChartTooltip() {
  chartTooltip.hidden = true;
}

function bindChartTooltip(node, lines) {
  const show = (event) => showChartTooltip(lines, event, node);
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', () => {
    if (document.activeElement !== node) hideChartTooltip();
  });
  node.addEventListener('focus', show);
  node.addEventListener('blur', hideChartTooltip);
}

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
  hideChartTooltip();
  const values = rows.map((row) => numeric(row.calls));
  const maximum = Math.max(1, ...values);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const width = Math.max(760, rows.length * 24);
  const height = 240;
  const plotLeft = 42;
  const plotRight = width - 8;
  const plotTop = 16;
  const baseline = 190;
  const plotHeight = baseline - plotTop;
  const labelCount = Math.min(10, rows.length);
  const labelIndexes = new Set(Array.from({ length: labelCount }, (_, index) => (
    labelCount === 1 ? 0 : Math.round(index * (rows.length - 1) / (labelCount - 1))
  )));
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('trend-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const gridGroup = document.createElementNS(svgNamespace, 'g');
  gridGroup.setAttribute('aria-hidden', 'true');
  [1, .75, .5, .25].forEach((ratio) => {
    const y = plotTop + plotHeight * (1 - ratio);
    const gridline = document.createElementNS(svgNamespace, 'line');
    gridline.classList.add('gridline');
    gridline.setAttribute('x1', String(plotLeft));
    gridline.setAttribute('x2', String(plotRight));
    gridline.setAttribute('y1', String(y));
    gridline.setAttribute('y2', String(y));
    const label = document.createElementNS(svgNamespace, 'text');
    label.classList.add('y-axis-label');
    label.setAttribute('x', String(plotLeft - 8));
    label.setAttribute('y', String(y + 3));
    label.setAttribute('text-anchor', 'end');
    label.textContent = number.format(Math.round(maximum * ratio));
    gridGroup.append(gridline, label);
  });
  svg.append(gridGroup);
  const axis = document.createElementNS(svgNamespace, 'line');
  axis.classList.add('axis');
  axis.setAttribute('x1', String(plotLeft));
  axis.setAttribute('x2', String(plotRight));
  axis.setAttribute('y1', String(baseline));
  axis.setAttribute('y2', String(baseline));
  svg.append(axis);
  rows.forEach((row, index) => {
    const slot = (plotRight - plotLeft) / Math.max(1, rows.length);
    const calls = values[index];
    const connected = numeric(row.connected);
    const installations = numeric(row.installations);
    const barHeight = calls > 0 ? Math.max(3, Math.round((calls / maximum) * plotHeight)) : 2;
    const bar = document.createElementNS(svgNamespace, 'rect');
    bar.classList.add('bar');
    bar.setAttribute('x', String(plotLeft + index * slot + slot * .15));
    bar.setAttribute('y', String(baseline - barHeight));
    bar.setAttribute('width', String(slot * .7));
    bar.setAttribute('height', String(barHeight));
    bar.setAttribute('rx', '3');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${row.date}，外呼总量 ${number.format(calls)}，接通 ${number.format(connected)}，活跃安装 ${number.format(installations)}`);
    const tooltipLines = [
      row.date,
      `外呼总量：${number.format(calls)}`,
      `接通数：${number.format(connected)}`,
      `活跃安装：${number.format(installations)}`,
    ];
    bindChartTooltip(bar, tooltipLines);
    const title = document.createElementNS(svgNamespace, 'title');
    title.textContent = tooltipLines.join('，');
    bar.append(title);
    svg.append(bar);
    if (labelIndexes.has(index)) {
      const label = document.createElementNS(svgNamespace, 'text');
      label.classList.add('date-label');
      label.setAttribute('x', String(plotLeft + index * slot + slot / 2));
      label.setAttribute('y', '210');
      label.setAttribute('text-anchor', index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle');
      label.textContent = String(row.date).slice(5);
      svg.append(label);
    }
  });
  byId('trend').replaceChildren(svg);
}

const countryNames = { CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾', SG: '新加坡', MY: '马来西亚', ZZ: '未知' };
function renderBars(id, rows, formatter = (value) => String(value)) {
  hideChartTooltip();
  const values = rows.map((row) => numeric(row.value));
  const maximum = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const nodes = rows.length ? rows.map((row) => {
    const rowValue = numeric(row.value);
    const labelText = formatter(row.label);
    const percentage = total ? (rowValue / total) * 100 : 0;
    const node = document.createElement('div');
    node.className = 'bar-row';
    node.tabIndex = 0;
    node.setAttribute('role', 'img');
    const label = document.createElement('span');
    label.textContent = labelText;
    label.title = label.textContent;
    const track = document.createElement('span');
    track.className = 'bar-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(0, Math.min(100, (rowValue / maximum) * 100))}%`;
    track.append(fill);
    const value = document.createElement('strong');
    value.textContent = number.format(rowValue);
    node.setAttribute('aria-label', `${labelText}，数量 ${number.format(rowValue)}，占比 ${percentage.toFixed(1)}%`);
    bindChartTooltip(node, [
      labelText,
      `数量：${number.format(rowValue)}`,
      `占该分类总量：${percentage.toFixed(1)}%`,
    ]);
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

let announcementsById = new Map();

function announcementCell(value, className = '') {
  const td = document.createElement('td');
  td.textContent = value;
  if (className) td.className = className;
  return td;
}

function renderAnnouncements(rows) {
  announcementsById = new Map(rows.map((announcement) => [Number(announcement.id), announcement]));
  const nodes = rows.map((announcement) => {
    const tr = document.createElement('tr');
    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = `announcement-status-tag${announcement.active ? ' active' : ''}`;
    status.textContent = announcement.active ? '当前' : '历史';
    statusCell.append(status);
    const actions = document.createElement('td');
    actions.className = 'announcement-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openAnnouncementEditor(Number(announcement.id)));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => deleteAnnouncement(Number(announcement.id), remove));
    actions.append(edit, remove);
    tr.append(
      announcementCell(dateTime.format(new Date(announcement.publishedAt))),
      announcementCell(`#${announcement.id}`),
      statusCell,
      announcementCell(announcement.title),
      announcementCell(announcement.content, 'announcement-content-cell'),
      actions,
    );
    return tr;
  });
  if (!nodes.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'muted';
    td.textContent = '尚未发布公告';
    tr.append(td);
    nodes.push(tr);
  }
  byId('announcements').replaceChildren(...nodes);
}

async function loadAnnouncements() {
  const response = await fetch('/admin/api/announcements', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) { location.href = '/login'; return; }
  if (!response.ok) throw new Error(`公告加载失败（HTTP ${response.status}）`);
  const result = await response.json();
  renderAnnouncements(Array.isArray(result.items) ? result.items : []);
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

const announcementForm = byId('announcement-form');
const announcementContent = byId('announcement-content');
const announcementSubmit = byId('announcement-submit');
const announcementStatus = byId('announcement-status');
const announcementEditDialog = byId('announcement-edit-dialog');
const announcementEditForm = byId('announcement-edit-form');
const announcementEditContent = byId('announcement-edit-content');
const announcementEditError = byId('announcement-edit-error');
const announcementEditSubmit = byId('announcement-edit-submit');
let editingAnnouncementId = null;

function showAnnouncementStatus(message, error = false) {
  announcementStatus.textContent = message;
  announcementStatus.className = error ? 'form-error' : 'form-status';
  announcementStatus.hidden = false;
}

function openAnnouncementEditor(announcementId) {
  const announcement = announcementsById.get(announcementId);
  if (!announcement) return;
  editingAnnouncementId = announcementId;
  announcementEditForm.reset();
  byId('announcement-edit-title').value = announcement.title;
  announcementEditContent.value = announcement.content;
  byId('announcement-edit-count').textContent = `${announcement.content.length} / 2000`;
  byId('announcement-edit-note').textContent = announcement.active
    ? '这是当前公告。保存后，已经阅读过的终端会在下次冷启动时再次弹出。'
    : '这是历史公告。修改内容不会发送给终端。';
  announcementEditError.hidden = true;
  announcementEditDialog.showModal();
  byId('announcement-edit-title').focus();
}

async function deleteAnnouncement(announcementId, button) {
  const announcement = announcementsById.get(announcementId);
  if (!announcement) return;
  const message = announcement.active
    ? '删除当前公告后，终端将不再收到这条公告，历史公告不会自动恢复。确认删除吗？'
    : '确认删除这条历史公告吗？';
  if (!window.confirm(message)) return;
  button.disabled = true;
  button.textContent = '删除中';
  try {
    const csrf = announcementForm.elements.namedItem('csrf').value;
    const response = await fetch(`/admin/api/announcements/${encodeURIComponent(announcementId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ csrf }),
    });
    if (response.status === 401) { location.href = '/login'; return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    showAnnouncementStatus(`公告 #${announcementId} 已删除`);
    await loadAnnouncements();
  } catch (error) {
    showAnnouncementStatus(`删除失败：${error.message}`, true);
    button.disabled = false;
    button.textContent = '删除';
  }
}

announcementContent.addEventListener('input', () => {
  byId('announcement-count').textContent = `${announcementContent.value.length} / 2000`;
});
announcementForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  announcementStatus.hidden = true;
  if (!window.confirm('发布后，新公告会在所有支持该功能的 APP 下次启动时弹出。确认发布吗？')) return;
  announcementSubmit.disabled = true;
  announcementSubmit.textContent = '正在发布';
  try {
    const response = await fetch('/admin/api/announcements', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(new FormData(announcementForm)),
    });
    if (response.status === 401) { location.href = '/login'; return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    announcementForm.reset();
    byId('announcement-count').textContent = '0 / 2000';
    showAnnouncementStatus(`公告 #${result.id} 已发布`);
    await loadAnnouncements();
  } catch (error) {
    showAnnouncementStatus(`发布失败：${error.message}`, true);
  } finally {
    announcementSubmit.disabled = false;
    announcementSubmit.textContent = '发布新公告';
  }
});

announcementEditContent.addEventListener('input', () => {
  byId('announcement-edit-count').textContent = `${announcementEditContent.value.length} / 2000`;
});
byId('announcement-edit-cancel').addEventListener('click', () => announcementEditDialog.close());
announcementEditDialog.addEventListener('click', (event) => {
  if (event.target === announcementEditDialog) announcementEditDialog.close();
});
announcementEditForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const announcement = announcementsById.get(editingAnnouncementId);
  if (!announcement) {
    announcementEditDialog.close();
    showAnnouncementStatus('该公告已不存在，请刷新后重试', true);
    return;
  }
  if (
    announcement.active &&
    !window.confirm('保存当前公告后，已经阅读过的终端会在下次冷启动时再次弹出。确认保存吗？')
  ) return;
  announcementEditError.hidden = true;
  announcementEditSubmit.disabled = true;
  announcementEditSubmit.textContent = '保存中';
  try {
    const response = await fetch(`/admin/api/announcements/${encodeURIComponent(editingAnnouncementId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(new FormData(announcementEditForm)),
    });
    if (response.status === 401) { location.href = '/login'; return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    announcementEditDialog.close();
    showAnnouncementStatus(`公告 #${result.id} 已更新`);
    await loadAnnouncements();
  } catch (error) {
    announcementEditError.textContent = `保存失败：${error.message}`;
    announcementEditError.hidden = false;
  } finally {
    announcementEditSubmit.disabled = false;
    announcementEditSubmit.textContent = '保存修改';
  }
});

byId('range').addEventListener('change', load);
byId('refresh').addEventListener('click', load);
load();
loadAnnouncements().catch((error) => {
  announcementStatus.textContent = error.message;
  announcementStatus.className = 'form-error';
  announcementStatus.hidden = false;
});
