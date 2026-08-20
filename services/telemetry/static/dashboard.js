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
    ['今日活跃安装', number.format(m.activeToday), '已授权匿名统计'],
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
    if (rows.length <= 31 || index % Math.ceil(rows.length / 15) === 0) {
      const label = document.createElementNS(svgNamespace, 'text');
      label.setAttribute('x', String(index * slot + slot / 2));
      label.setAttribute('y', '202');
      label.setAttribute('text-anchor', 'middle');
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
    td.textContent = '暂无已授权统计的活跃安装';
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

byId('range').addEventListener('change', load);
byId('refresh').addEventListener('click', load);
load();
