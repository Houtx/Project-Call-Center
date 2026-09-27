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
  node.addEventListener('pointermove', (event) => {
    if (!chartTooltip.hidden) positionChartTooltip(event.clientX, event.clientY, node);
  });
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

function metric(label, value, note, tone) {
  const node = document.createElement('article');
  node.className = `metric-card tone-${tone}`;
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
    ['今日活跃安装', number.format(m.activeToday), '已启用匿名统计', 'primary'],
    [`近 ${data.rangeDays} 天活跃`, number.format(m.activeRange), `观测安装 ${number.format(m.observedInstallations)}`, 'teal'],
    ['外呼总量', number.format(m.callCount), `接通 ${number.format(m.connectedCount)} · 未接 ${number.format(m.notConnectedCount)}`, 'teal'],
    ['接通率', `${(m.connectionRate * 100).toFixed(1)}%`, `未知 ${number.format(m.unknownCount)} 通不计入分母`, 'primary'],
    ['总通话时长', duration(m.totalDurationSeconds), '仅汇总已接通通话', 'amber'],
    ['平均通话时长', duration(m.averageDurationSeconds), '按接通通话计算', 'amber'],
    ['来源 IP 数', number.format(m.ipCount), 'IP 仅保存 HMAC 与脱敏网段', 'neutral'],
    ['明细保留', `${data.retentionDays} 天`, '汇总数据长期保留', 'neutral'],
  ];
  byId('metrics').replaceChildren(...values.map((item) => metric(...item)));
}

function renderTrend(rows) {
  hideChartTooltip();
  const values = rows.map((row) => numeric(row.calls));
  const maximum = Math.max(1, ...values);
  const targetStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const residual = targetStep / magnitude;
  const niceFactor = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  const tickStep = Math.max(1, niceFactor * magnitude);
  const graphMaximum = tickStep * 4;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const dailyWidth = rows.length > 90 ? 14 : 24;
  const width = Math.max(760, rows.length * dailyWidth + 58, byId('trend').clientWidth || 0);
  const height = 250;
  const plotLeft = 42;
  const plotRight = width - 8;
  const plotTop = 18;
  const baseline = 210;
  const plotHeight = baseline - plotTop;
  const labelCount = Math.min(10, rows.length);
  const labelIndexes = new Set(Array.from({ length: labelCount }, (_, index) => (
    labelCount === 1 ? 0 : Math.round(index * (rows.length - 1) / (labelCount - 1))
  )));
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('trend-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = `${width}px`;
  svg.style.minWidth = `${width}px`;
  const gridGroup = document.createElementNS(svgNamespace, 'g');
  gridGroup.setAttribute('aria-hidden', 'true');
  [0, 1, 2, 3, 4].forEach((tick) => {
    const ratio = tick / 4;
    const y = baseline - plotHeight * ratio;
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
    label.textContent = number.format(tickStep * tick);
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
    const connected = Math.min(calls, numeric(row.connected));
    const installations = numeric(row.installations);
    const barHeight = calls > 0 ? Math.max(3, Math.round((calls / graphMaximum) * plotHeight)) : 2;
    const connectedHeight = connected > 0 ? Math.max(2, Math.round((connected / graphMaximum) * plotHeight)) : 0;
    const barWidth = Math.min(28, slot * .68);
    const x = plotLeft + index * slot + (slot - barWidth) / 2;
    const connectionRate = calls ? (connected / calls) * 100 : 0;
    const group = document.createElementNS(svgNamespace, 'g');
    group.classList.add('day-group');
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', `${row.date}，外呼总量 ${number.format(calls)}，接通 ${number.format(connected)}，接通率 ${connectionRate.toFixed(1)}%，活跃安装 ${number.format(installations)}`);
    const bar = document.createElementNS(svgNamespace, 'rect');
    bar.classList.add('bar');
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(baseline - barHeight));
    bar.setAttribute('width', String(barWidth));
    bar.setAttribute('height', String(barHeight));
    bar.setAttribute('rx', '3');
    const connectedBar = document.createElementNS(svgNamespace, 'rect');
    connectedBar.classList.add('bar-connected');
    connectedBar.setAttribute('x', String(x));
    connectedBar.setAttribute('y', String(baseline - connectedHeight));
    connectedBar.setAttribute('width', String(barWidth));
    connectedBar.setAttribute('height', String(connectedHeight));
    connectedBar.setAttribute('rx', '3');
    const tooltipLines = [
      row.date,
      `外呼总量：${number.format(calls)}`,
      `接通数：${number.format(connected)}`,
      `接通率：${connectionRate.toFixed(1)}%`,
      `活跃安装：${number.format(installations)}`,
    ];
    bindChartTooltip(group, tooltipLines);
    const title = document.createElementNS(svgNamespace, 'title');
    title.textContent = tooltipLines.join('，');
    group.append(title, bar, connectedBar);
    svg.append(group);
    if (labelIndexes.has(index)) {
      const label = document.createElementNS(svgNamespace, 'text');
      label.classList.add('date-label');
      label.setAttribute('x', String(plotLeft + index * slot + slot / 2));
      label.setAttribute('y', '236');
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
      td.title = value;
      if (index === 2) {
        const tag = document.createElement('span');
        tag.className = `mode-tag ${row.mode === 'offline' ? 'offline' : 'online'}`;
        tag.textContent = value;
        td.append(tag);
      } else {
        td.textContent = value;
      }
      if ([1, 4, 6].includes(index)) td.classList.add('cell-mono');
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

const mapMetricLabels = {
  devices: '活跃终端数',
  calls: '外呼量',
  connected: '接通量',
  notConnected: '未接通量',
  connectionRate: '接通率',
  totalDurationSeconds: '总通话时长',
  averageDurationSeconds: '平均通话时长',
};
let distributionMap = null;
let distributionLayer = null;
let mapData = null;
let mapRequestController = null;
let mapRequestTimer = null;

const gcjPi = Math.PI;
const gcjEarthRadius = 6378245.0;
const gcjEccentricity = 0.006693421622965943;

function outsideMainlandChina(latitude, longitude) {
  return longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271;
}

function transformGcjLatitude(x, y) {
  let result = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * gcjPi) + 20 * Math.sin(2 * x * gcjPi)) * 2 / 3;
  result += (20 * Math.sin(y * gcjPi) + 40 * Math.sin(y / 3 * gcjPi)) * 2 / 3;
  result += (160 * Math.sin(y / 12 * gcjPi) + 320 * Math.sin(y * gcjPi / 30)) * 2 / 3;
  return result;
}

function transformGcjLongitude(x, y) {
  let result = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * gcjPi) + 20 * Math.sin(2 * x * gcjPi)) * 2 / 3;
  result += (20 * Math.sin(x * gcjPi) + 40 * Math.sin(x / 3 * gcjPi)) * 2 / 3;
  result += (150 * Math.sin(x / 12 * gcjPi) + 300 * Math.sin(x / 30 * gcjPi)) * 2 / 3;
  return result;
}

function wgs84ToGcj02(latitude, longitude) {
  if (outsideMainlandChina(latitude, longitude)) return [latitude, longitude];
  let latitudeDelta = transformGcjLatitude(longitude - 105, latitude - 35);
  let longitudeDelta = transformGcjLongitude(longitude - 105, latitude - 35);
  const radians = latitude / 180 * gcjPi;
  let magic = Math.sin(radians);
  magic = 1 - gcjEccentricity * magic * magic;
  const rootMagic = Math.sqrt(magic);
  latitudeDelta = latitudeDelta * 180 / (
    (gcjEarthRadius * (1 - gcjEccentricity)) / (magic * rootMagic) * gcjPi
  );
  longitudeDelta = longitudeDelta * 180 / (
    gcjEarthRadius / rootMagic * Math.cos(radians) * gcjPi
  );
  return [latitude + latitudeDelta, longitude + longitudeDelta];
}

function gcj02ToWgs84(latitude, longitude) {
  if (outsideMainlandChina(latitude, longitude)) return [latitude, longitude];
  const converted = wgs84ToGcj02(latitude, longitude);
  return [latitude * 2 - converted[0], longitude * 2 - converted[1]];
}

function mapMetricValue(item, metricName = byId('map-metric').value) {
  return numeric(item[metricName]);
}

function formatMapMetric(value, metricName = byId('map-metric').value) {
  if (metricName === 'connectionRate') return `${(value * 100).toFixed(1)}%`;
  if (metricName === 'totalDurationSeconds' || metricName === 'averageDurationSeconds') return duration(value);
  return number.format(Math.round(value));
}

function formatMarkerValue(value, metricName) {
  if (metricName === 'connectionRate') return `${Math.round(value * 100)}%`;
  if (metricName === 'totalDurationSeconds' || metricName === 'averageDurationSeconds') {
    if (value >= 3600) return `${(value / 3600).toFixed(value >= 36_000 ? 0 : 1)}h`;
    return `${Math.round(value / 60)}m`;
  }
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
  return number.format(Math.round(value));
}

function aggregateMapItems(items) {
  const first = items[0];
  const aggregate = {
    kind: 'device-group',
    latitude: first.latitude,
    longitude: first.longitude,
    devices: items.length,
    calls: 0,
    connected: 0,
    notConnected: 0,
    unknown: 0,
    totalDurationSeconds: 0,
    members: items,
  };
  items.forEach((item) => {
    aggregate.calls += numeric(item.calls);
    aggregate.connected += numeric(item.connected);
    aggregate.notConnected += numeric(item.notConnected);
    aggregate.unknown += numeric(item.unknown);
    aggregate.totalDurationSeconds += numeric(item.totalDurationSeconds);
  });
  const denominator = aggregate.connected + aggregate.notConnected;
  aggregate.connectionRate = denominator ? aggregate.connected / denominator : 0;
  aggregate.averageDurationSeconds = aggregate.connected
    ? aggregate.totalDurationSeconds / aggregate.connected
    : 0;
  return aggregate;
}

function groupIdenticalDevices(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = `${Number(item.latitude).toFixed(7)},${Number(item.longitude).toFixed(7)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()].map(aggregateMapItems);
}

function appendPopupMetric(list, label, value) {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  list.append(term, detail);
}

function createMapPopup(item) {
  const popup = document.createElement('div');
  popup.className = 'map-popup';
  const title = document.createElement('h4');
  title.textContent = item.kind === 'cluster'
    ? `区域聚合 · ${number.format(item.devices)} 台终端`
    : item.devices > 1
      ? `同一位置 · ${number.format(item.devices)} 台终端`
      : `设备 ${item.members[0].installation}`;
  const details = document.createElement('dl');
  appendPopupMetric(details, '外呼量', number.format(item.calls));
  appendPopupMetric(details, '接通 / 未接', `${number.format(item.connected)} / ${number.format(item.notConnected)}`);
  appendPopupMetric(details, '接通率', `${(numeric(item.connectionRate) * 100).toFixed(1)}%`);
  appendPopupMetric(details, '总通话时长', duration(item.totalDurationSeconds));
  popup.append(title, details);
  if (item.members) {
    if (item.members.length === 1) {
      const device = item.members[0];
      const timeInfo = document.createElement('p');
      timeInfo.style.margin = '7px 0 0';
      timeInfo.style.fontSize = '11px';
      timeInfo.style.color = 'var(--muted)';
      timeInfo.textContent = `首呼定位：${dateTime.format(new Date(device.capturedAt))} · 精度 ${Math.round(numeric(device.accuracyMeters))} 米`;
      popup.append(timeInfo);
      const trackBtn = document.createElement('button');
      trackBtn.type = 'button';
      trackBtn.className = 'track-action-btn';
      trackBtn.textContent = '📍 查看此设备打卡轨迹';
      trackBtn.addEventListener('click', () => {
        if (distributionMap) distributionMap.closePopup();
        showDeviceTrack(device.deviceKey || device.installation);
      });
      popup.append(trackBtn);
    } else {
      const list = document.createElement('ul');
      list.className = 'map-device-list';
      item.members.forEach((device) => {
        const entry = document.createElement('li');
        const info = document.createElement('div');
        info.textContent = `${device.installation} · ${dateTime.format(new Date(device.capturedAt))} · 精度 ${Math.round(numeric(device.accuracyMeters))} 米 · 外呼 ${number.format(device.calls)}`;
        const itemTrackBtn = document.createElement('button');
        itemTrackBtn.type = 'button';
        itemTrackBtn.className = 'track-action-btn';
        itemTrackBtn.style.marginTop = '4px';
        itemTrackBtn.textContent = `查看设备 ${device.installation} 轨迹`;
        itemTrackBtn.addEventListener('click', () => {
          if (distributionMap) distributionMap.closePopup();
          showDeviceTrack(device.deviceKey || device.installation);
        });
        entry.append(info, itemTrackBtn);
        list.append(entry);
      });
      popup.append(list);
    }
  }
  return popup;
}

function markerIcon(value, size, grouped = false) {
  const text = formatMarkerValue(value, byId('map-metric').value);
  const marker = document.createElement('span');
  marker.className = `map-value-marker${grouped ? ' device-group' : ''}`;
  marker.textContent = text;
  return globalThis.L.divIcon({
    className: 'map-value-icon',
    html: marker.outerHTML,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function renderMap() {
  if (!distributionMap || !distributionLayer || !mapData) return;
  distributionLayer.clearLayers();
  const metricName = byId('map-metric').value;
  const sourceItems = mapData.mode === 'devices'
    ? groupIdenticalDevices(mapData.items)
    : mapData.items;
  const maximum = Math.max(1, ...sourceItems.map((item) => mapMetricValue(item, metricName)));
  sourceItems.forEach((item) => {
    const value = mapMetricValue(item, metricName);
    const mapCoordinates = wgs84ToGcj02(Number(item.latitude), Number(item.longitude));
    if (item.kind === 'cluster') {
      const size = 36 + Math.round(Math.sqrt(value / maximum) * 28);
      const marker = globalThis.L.marker(mapCoordinates, {
        icon: markerIcon(value, size),
        keyboard: true,
        title: `${mapMetricLabels[metricName]} ${formatMapMetric(value, metricName)}`,
      }).addTo(distributionLayer);
      marker.bindTooltip(createMapPopup(item), { direction: 'top', offset: [0, -size / 2] });
      marker.on('click', () => {
        distributionMap.setView(marker.getLatLng(), Math.min(13, distributionMap.getZoom() + 2));
      });
      return;
    }
    let marker;
    if (item.devices > 1) {
      const size = 38 + Math.min(18, Math.round(Math.sqrt(item.devices) * 4));
      marker = globalThis.L.marker(mapCoordinates, {
        icon: markerIcon(item.devices, size, true),
        keyboard: true,
        title: `同一位置 ${number.format(item.devices)} 台终端`,
      });
    } else {
      marker = globalThis.L.circleMarker(mapCoordinates, {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1689a0',
        fillOpacity: 0.92,
      });
    }
    marker.addTo(distributionLayer).bindPopup(createMapPopup(item), { maxWidth: 360 });
  });
  const deviceCount = mapData.items.reduce((sum, item) => sum + numeric(item.devices), 0);
  const dateParams = getMapDateParams();
  byId('map-summary').textContent = `已定位 ${number.format(deviceCount)} 台终端 · ${number.format(sourceItems.length)} 个地图点（${dateParams.label}）`;
  byId('map-status').textContent = mapData.truncated
    ? `当前区域设备过多，已显示前 ${number.format(mapData.items.length)} 台，请放大查看`
    : `缩放级别 ${mapData.zoom} · ${mapData.mode === 'clusters' ? '区域聚合' : '设备明细'}`;
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMapDateParams() {
  const mapRangeSelect = byId('map-range');
  const mode = mapRangeSelect ? mapRangeSelect.value : '30';
  const now = new Date();
  const todayStr = formatIsoDate(now);

  if (mode === 'today') {
    return { startDate: todayStr, endDate: todayStr, label: '今天', mode };
  }
  if (mode === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatIsoDate(yesterday);
    return { startDate: yesterdayStr, endDate: yesterdayStr, label: '昨天', mode };
  }
  if (mode === 'single') {
    const singleInput = byId('map-single-date');
    const val = singleInput && singleInput.value ? singleInput.value : todayStr;
    return { startDate: val, endDate: val, label: val, mode };
  }
  if (mode === 'custom') {
    const startInput = byId('map-start-date');
    const endInput = byId('map-end-date');
    const startVal = startInput && startInput.value ? startInput.value : todayStr;
    const endVal = endInput && endInput.value ? endInput.value : todayStr;
    return { startDate: startVal, endDate: endVal, label: `${startVal} 至 ${endVal}`, mode };
  }
  const days = Number(mode) || 30;
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: formatIsoDate(start), endDate: todayStr, label: `近 ${days} 天`, days, mode };
}

let activeTrackInstallation = null;
let activeTrackDays = '30';
let trackLayer = null;
let isTrackLoading = false;

function normalizedMapBounds() {
  const bounds = distributionMap.getBounds();
  const westRaw = bounds.getWest();
  const eastRaw = bounds.getEast();
  if (eastRaw - westRaw >= 360) return [-180, bounds.getSouth(), 180, bounds.getNorth()];
  const normalizeLongitude = (value) => ((value + 180) % 360 + 360) % 360 - 180;
  const west = normalizeLongitude(westRaw);
  const east = normalizeLongitude(eastRaw);
  const south = Math.max(-85.051129, bounds.getSouth());
  const north = Math.min(85.051129, bounds.getNorth());
  const southWest = gcj02ToWgs84(south, west);
  const northEast = gcj02ToWgs84(north, east);
  return [southWest[1], southWest[0], northEast[1], northEast[0]];
}

async function loadMap() {
  if (!distributionMap || activeTrackInstallation) return;
  if (mapRequestController) mapRequestController.abort();
  mapRequestController = typeof AbortController === 'function' ? new AbortController() : null;
  byId('map-error').hidden = true;
  byId('map-status').textContent = '正在读取当前地图范围';
  const bounds = normalizedMapBounds().map((value) => value.toFixed(6)).join(',');
  const dateParams = getMapDateParams();
  const params = new URLSearchParams({
    start_date: dateParams.startDate,
    end_date: dateParams.endDate,
    zoom: String(distributionMap.getZoom()),
    bbox: bounds,
  });
  const options = { credentials: 'same-origin', cache: 'no-store' };
  if (mapRequestController) options.signal = mapRequestController.signal;
  try {
    const response = await fetch(`/admin/api/map?${params}`, options);
    if (response.status === 401) { location.href = '/login'; return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mapData = await response.json();
    if (!mapData || !Array.isArray(mapData.items)) throw new Error('地图数据格式无效');
    renderMap();
  } catch (error) {
    if (error.name === 'AbortError') return;
    byId('map-error').textContent = `地图数据加载失败：${error.message}`;
    byId('map-error').hidden = false;
    byId('map-status').textContent = '地图数据不可用';
  }
}

function scheduleMapLoad() {
  clearTimeout(mapRequestTimer);
  mapRequestTimer = setTimeout(loadMap, 180);
}

function calculateTrackDisplayCoordinates(points) {
  const coordGroups = new Map();
  points.forEach((pt, idx) => {
    const key = `${Number(pt.latitude).toFixed(4)},${Number(pt.longitude).toFixed(4)}`;
    if (!coordGroups.has(key)) coordGroups.set(key, []);
    coordGroups.get(key).push(idx);
  });

  const displayCoords = new Array(points.length);
  coordGroups.forEach((indices) => {
    if (indices.length === 1) {
      const idx = indices[0];
      displayCoords[idx] = wgs84ToGcj02(Number(points[idx].latitude), Number(points[idx].longitude));
    } else {
      indices.forEach((idx, order) => {
        const base = wgs84ToGcj02(Number(points[idx].latitude), Number(points[idx].longitude));
        const angle = (2 * Math.PI * order) / indices.length;
        const radius = 0.00018;
        const offsetLat = base[0] + radius * Math.cos(angle);
        const offsetLng = base[1] + (radius / Math.cos(base[0] * Math.PI / 180)) * Math.sin(angle);
        displayCoords[idx] = [offsetLat, offsetLng];
      });
    }
  });
  return displayCoords;
}

async function showDeviceTrack(installation, overrideDays = null) {
  if (isTrackLoading) return;
  activeTrackInstallation = installation;
  if (overrideDays) {
    activeTrackDays = String(overrideDays);
  } else {
    const currentMode = byId('map-range') ? byId('map-range').value : '30';
    if (currentMode === '7' || currentMode === '30' || currentMode === '90') {
      activeTrackDays = currentMode;
    } else {
      activeTrackDays = '30';
    }
  }

  const pills = document.querySelectorAll('#track-range-pills .track-pill');
  pills.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.days === activeTrackDays);
  });

  isTrackLoading = true;
  byId('map-error').hidden = true;
  byId('map-status').textContent = `正在读取设备 ${installation.slice(0, 10)} 轨迹...`;

  const now = new Date();
  const todayStr = formatIsoDate(now);
  const daysNum = Number(activeTrackDays) || 30;
  const start = new Date(now);
  start.setDate(start.getDate() - (daysNum - 1));
  const startDateStr = formatIsoDate(start);

  const params = new URLSearchParams({
    installation,
    start_date: startDateStr,
    end_date: todayStr,
  });
  const options = { credentials: 'same-origin', cache: 'no-store' };
  try {
    const response = await fetch(`/admin/api/device/track?${params}`, options);
    if (response.status === 401) { location.href = '/login'; return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const trackData = await response.json();
    renderDeviceTrack(trackData);
  } catch (error) {
    byId('map-error').textContent = `轨迹加载失败：${error.message}`;
    byId('map-error').hidden = false;
    byId('map-status').textContent = '轨迹数据不可用';
  } finally {
    isTrackLoading = false;
  }
}

function renderDeviceTrack(trackData) {
  if (distributionMap && globalThis.L) {
    if (distributionLayer) distributionLayer.clearLayers();
    if (!trackLayer) {
      trackLayer = globalThis.L.layerGroup().addTo(distributionMap);
    } else {
      trackLayer.clearLayers();
    }
  }

  const trackPanel = byId('map-track-panel');
  if (trackPanel) trackPanel.hidden = false;

  byId('track-title').textContent = `设备 ${trackData.installation} 轨迹`;
  byId('track-range-text').textContent = `${trackData.startDate} 至 ${trackData.endDate} · 近 ${activeTrackDays} 天`;

  const summaryEl = byId('track-summary');
  if (summaryEl) {
    const items = [
      ['打卡天数', `${trackData.totalPoints} 天`],
      ['期间外呼', number.format(trackData.metrics.calls)],
      ['接通率', `${(numeric(trackData.metrics.connectionRate) * 100).toFixed(1)}%`],
    ];
    summaryEl.replaceChildren(...items.map(([label, val]) => {
      const card = document.createElement('div');
      card.className = 'track-summary-item';
      const valEl = document.createElement('span');
      valEl.className = 'track-summary-val';
      valEl.textContent = val;
      const lblEl = document.createElement('span');
      lblEl.className = 'track-summary-lbl';
      lblEl.textContent = label;
      card.append(valEl, lblEl);
      return card;
    }));
  }

  const markers = [];
  const timelineEl = byId('track-timeline');
  if (timelineEl) {
    if (trackData.points.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'muted';
      emptyP.style.textAlign = 'center';
      emptyP.style.padding = '18px 0';
      emptyP.textContent = '该设备在所选时间范围内无打卡记录';
      timelineEl.replaceChildren(emptyP);
    } else {
      const itemNodes = trackData.points.map((pt, index) => {
        const seq = index + 1;
        const isLatest = index === trackData.points.length - 1;
        const itemNode = document.createElement('div');
        itemNode.className = 'track-timeline-item';
        const row = document.createElement('div');
        row.className = 'track-item-row';
        const dayBox = document.createElement('div');
        dayBox.className = 'track-item-day';
        const dot = document.createElement('span');
        dot.className = `track-dot-seq${isLatest ? ' is-latest' : ''}`;
        dot.textContent = String(seq);
        const dateEl = document.createElement('span');
        dateEl.className = 'track-item-date';
        dateEl.textContent = pt.date;
        dayBox.append(dot, dateEl);

        const timeEl = document.createElement('span');
        timeEl.className = 'track-item-time';
        timeEl.textContent = dateTime.format(new Date(pt.capturedAt)).split(' ')[1] || '';
        row.append(dayBox, timeEl);

        const metricsEl = document.createElement('div');
        metricsEl.className = 'track-item-metrics';
        metricsEl.textContent = `外呼 ${number.format(pt.calls)} · 接通率 ${(numeric(pt.connectionRate) * 100).toFixed(0)}% · 精度 ${Math.round(numeric(pt.accuracyMeters))}m`;

        itemNode.append(row, metricsEl);

        itemNode.addEventListener('click', () => {
          timelineEl.querySelectorAll('.track-timeline-item').forEach(el => el.classList.remove('active'));
          itemNode.classList.add('active');
          if (distributionMap && markers[index]) {
            distributionMap.setView(markers[index].getLatLng(), Math.max(distributionMap.getZoom(), 14));
            markers[index].openPopup();
          }
        });

        return itemNode;
      });
      timelineEl.replaceChildren(...itemNodes);
    }
  }

  if (distributionMap && globalThis.L && trackLayer && trackData.points.length > 0) {
    const displayCoords = calculateTrackDisplayCoordinates(trackData.points);

    if (displayCoords.length > 1) {
      globalThis.L.polyline(displayCoords, {
        color: '#087a55',
        weight: 3.5,
        opacity: 0.85,
        dashArray: '6, 6',
        lineJoin: 'round',
      }).addTo(trackLayer);
    }

    trackData.points.forEach((pt, index) => {
      const seq = index + 1;
      const isLatest = index === trackData.points.length - 1;
      const latLng = displayCoords[index];
      const marker = globalThis.L.marker(latLng, {
        icon: globalThis.L.divIcon({
          className: 'map-value-icon',
          html: `<span class="map-track-marker${isLatest ? ' is-latest' : ''}">${seq}</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: `第 ${seq} 天 · ${pt.date}`,
      }).addTo(trackLayer);
      markers.push(marker);

      const popup = document.createElement('div');
      popup.className = 'map-popup';
      const h4 = document.createElement('h4');
      h4.textContent = `第 ${seq} 天 · ${pt.date}${isLatest ? '（最新打卡）' : ''}`;
      const dl = document.createElement('dl');
      appendPopupMetric(dl, '外呼量', number.format(pt.calls));
      appendPopupMetric(dl, '接通 / 未接', `${number.format(pt.connected)} / ${number.format(pt.notConnected)}`);
      appendPopupMetric(dl, '接通率', `${(numeric(pt.connectionRate) * 100).toFixed(1)}%`);
      appendPopupMetric(dl, '通话时长', duration(pt.totalDurationSeconds));
      appendPopupMetric(dl, '首呼定位', dateTime.format(new Date(pt.capturedAt)));
      appendPopupMetric(dl, '定位精度', `${Math.round(numeric(pt.accuracyMeters))} 米`);
      popup.append(h4, dl);
      marker.bindPopup(popup, { maxWidth: 300 });
    });

    if (displayCoords.length === 1) {
      distributionMap.setView(displayCoords[0], Math.max(distributionMap.getZoom(), 13));
    } else {
      distributionMap.fitBounds(displayCoords, { padding: [50, 50], maxZoom: 15 });
    }
  }

  if (trackData.points.length > 0) {
    byId('map-status').textContent = `轨迹模式：设备 ${trackData.installation}（共 ${trackData.totalPoints} 个打卡点）`;
  } else {
    byId('map-status').textContent = `设备 ${trackData.installation} 在所选时段内无打卡记录`;
  }
}

function exitDeviceTrack() {
  activeTrackInstallation = null;
  const trackPanel = byId('map-track-panel');
  if (trackPanel) trackPanel.hidden = true;
  if (trackLayer) trackLayer.clearLayers();
  if (distributionMap) loadMap();
}

function initTrackPanelEvents() {
  const pills = document.querySelectorAll('#track-range-pills .track-pill');
  pills.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!activeTrackInstallation) return;
      showDeviceTrack(activeTrackInstallation, btn.dataset.days);
    });
  });
  const trackPanel = byId('map-track-panel');
  if (trackPanel && globalThis.L && globalThis.L.DomEvent) {
    globalThis.L.DomEvent.disableClickPropagation(trackPanel);
    globalThis.L.DomEvent.disableScrollPropagation(trackPanel);
  }
}

function onMapRangeChange() {
  const val = byId('map-range').value;
  const pickerWrap = byId('map-date-picker-wrap');
  const singleBox = byId('map-single-date-box');
  const customBox = byId('map-custom-date-box');
  if (pickerWrap) {
    if (val === 'single') {
      pickerWrap.hidden = false;
      singleBox.hidden = false;
      customBox.hidden = true;
      if (!byId('map-single-date').value) {
        byId('map-single-date').value = formatIsoDate(new Date());
      }
    } else if (val === 'custom') {
      pickerWrap.hidden = false;
      singleBox.hidden = true;
      customBox.hidden = false;
      const now = new Date();
      if (!byId('map-end-date').value) byId('map-end-date').value = formatIsoDate(now);
      if (!byId('map-start-date').value) {
        const past = new Date(now);
        past.setDate(past.getDate() - 7);
        byId('map-start-date').value = formatIsoDate(past);
      }
      return;
    } else {
      pickerWrap.hidden = true;
      singleBox.hidden = true;
      customBox.hidden = true;
    }
  }
  scheduleMapLoad();
}

function initDistributionMap() {
  if (!globalThis.L) {
    byId('map-error').textContent = '地图组件加载失败，请刷新页面重试';
    byId('map-error').hidden = false;
    byId('map-summary').textContent = '地图不可用';
    return;
  }
  const container = byId('distribution-map');
  const tileUrl = container.dataset.tileUrl.startsWith('__')
    ? 'https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
    : container.dataset.tileUrl;
  const attribution = container.dataset.attribution.startsWith('__')
    ? '高德地图'
    : container.dataset.attribution;
  distributionMap = globalThis.L.map(container, { preferCanvas: true, minZoom: 2, maxZoom: 20 })
    .setView([34.5, 105], 3);
  globalThis.L.tileLayer(tileUrl, { attribution, maxZoom: 20 }).addTo(distributionMap);
  distributionLayer = globalThis.L.layerGroup().addTo(distributionMap);
  distributionMap.on('moveend', scheduleMapLoad);
  distributionMap.whenReady(loadMap);
}

let announcementsById = new Map();

function renderAnnouncements(rows) {
  announcementsById = new Map(rows.map((announcement) => [Number(announcement.id), announcement]));
  const activeAnnouncement = rows.find((announcement) => announcement.active);
  byId('announcement-summary').textContent = activeAnnouncement
    ? `当前公告 #${activeAnnouncement.id} · 共 ${number.format(rows.length)} 条记录`
    : `暂无当前公告 · 共 ${number.format(rows.length)} 条记录`;
  const nodes = rows.map((announcement) => {
    const item = document.createElement('article');
    item.className = `announcement-item${announcement.active ? ' current' : ''}`;
    item.setAttribute('role', 'listitem');
    const body = document.createElement('div');
    body.className = 'announcement-item-body';
    const header = document.createElement('div');
    header.className = 'announcement-item-header';
    const status = document.createElement('span');
    status.className = `announcement-status-tag${announcement.active ? ' active' : ''}`;
    status.textContent = announcement.active ? '当前' : '历史';
    const meta = document.createElement('span');
    meta.className = 'announcement-item-meta';
    meta.textContent = `#${announcement.id} · ${dateTime.format(new Date(announcement.publishedAt))} · 修订 ${announcement.revision}`;
    header.append(status, meta);
    const title = document.createElement('h4');
    title.textContent = announcement.title;
    const content = document.createElement('p');
    content.className = 'announcement-content';
    content.textContent = announcement.content;
    content.title = announcement.content;
    body.append(header, title, content);
    const actions = document.createElement('div');
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
    item.append(body, actions);
    return item;
  });
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '尚未发布公告';
    nodes.push(empty);
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
  const refresh = byId('refresh');
  const refreshLabel = refresh.textContent;
  byId('loading').hidden = false;
  byId('error').hidden = true;
  refresh.disabled = true;
  refresh.textContent = '正在刷新';
  try {
    const response = await fetch(`/admin/api/dashboard?days=${byId('range').value}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
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
    refresh.disabled = false;
    refresh.textContent = refreshLabel;
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

byId('range').addEventListener('change', () => {
  load();
});
byId('refresh').addEventListener('click', () => {
  load();
  loadMap();
});
byId('map-metric').addEventListener('change', renderMap);
if (byId('map-range')) byId('map-range').addEventListener('change', onMapRangeChange);
if (byId('map-single-date')) byId('map-single-date').addEventListener('change', scheduleMapLoad);
if (byId('map-date-apply')) byId('map-date-apply').addEventListener('click', scheduleMapLoad);
if (byId('track-exit-btn')) byId('track-exit-btn').addEventListener('click', exitDeviceTrack);
initTrackPanelEvents();
initDistributionMap();
load();
loadAnnouncements().catch((error) => {
  announcementStatus.textContent = error.message;
  announcementStatus.className = 'form-error';
  announcementStatus.hidden = false;
});
