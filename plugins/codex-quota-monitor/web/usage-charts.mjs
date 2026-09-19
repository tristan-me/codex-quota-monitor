import { formatTaskPercent } from './dashboard-utils.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MODE_KEY = 'codexQuotaMonitor.trendMode';
const SCOPE_KEY = 'codexQuotaMonitor.attributionScope';
const POINT_KEY = 'codexQuotaMonitor.trendPoint';
const SESSION_CHART_KEY = 'codexQuotaMonitor.sessionChartExpanded.';
const boundModes = new WeakSet();
const boundScopes = new WeakSet();
const sessionColors = new Map();
const sessionChartPreferences = new Map();
const palette = ['#66b3ff', '#63d7b0', '#ecac64', '#bc9aff', '#ed8aba', '#75d3e6', '#ced57c', '#e58978'];
let tooltipSequence = 0;
let sessionChartSequence = 0;
let activeTooltip = null;
let tooltipEventsBound = false;
let latestTrendSnapshot = null;
let latestAttributionSnapshot = null;
let trendMode = null;
let attributionScope = null;
let selectedPointId = null;
let selectedPoint = null;
let selectionInitialized = false;
let detailsOpen = true;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textValue = (value, fallback = '') => typeof value === 'string' ? value.trim() || fallback : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const nonnegative = value => { const parsed = number(value); return parsed !== null && parsed >= 0 ? parsed : null; };
const byId = id => document.getElementById(id);
const setText = (id, value) => { const element = byId(id); if (element) element.textContent = value; };

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const numeric = number(value);
  if (numeric !== null) {
    const result = Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
    return Number.isFinite(new Date(result).getTime()) ? result : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function formatTime(at, full = false) {
  if (at === null) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(full ? { second: '2-digit' } : {}), hourCycle: 'h23',
  }).format(new Date(at));
}

function percent(value) {
  const parsed = number(value);
  return parsed === null ? '—' : formatTaskPercent(parsed);
}

function duration(value, fallback = '未记录') {
  const parsed = nonnegative(value);
  if (parsed === null) return fallback;
  const total = Math.floor(parsed);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  return `${hours ? `${hours}时` : ''}${hours || minutes ? `${minutes}分` : ''}${total % 60}秒`;
}

function tokens(value) {
  const parsed = nonnegative(value);
  return parsed === null ? '—' : `${Math.round(parsed).toLocaleString('zh-CN')} tokens`;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function svgElement(tag, attributes = {}, value) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, attribute] of Object.entries(attributes)) node.setAttribute(key, String(attribute));
  if (value !== undefined) node.textContent = value;
  return node;
}

function readPreference(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return !allowed || allowed.includes(value) ? value || fallback : fallback;
  } catch { return fallback; }
}

function savePreference(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* Storage may be unavailable in private browsing. */ }
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

function colorsFor(chartId, segments) {
  let colors = sessionColors.get(chartId);
  if (!colors) { colors = new Map(); sessionColors.set(chartId, colors); }
  const used = new Set(colors.values());
  for (const segment of [...segments].sort((a, b) => a.id.localeCompare(b.id))) {
    if (colors.has(segment.id)) continue;
    const start = hash(segment.id) % palette.length;
    let color = palette[start];
    for (let index = 0; index < palette.length && used.has(color); index += 1) color = palette[(start + index + 1) % palette.length];
    if (used.has(color)) {
      let hue = hash(segment.id) % 3600 / 10;
      color = `hsl(${hue} 72% 68%)`;
      while (used.has(color)) { hue = Math.round((hue + 137.5) % 360 * 10) / 10; color = `hsl(${hue} 72% 68%)`; }
    }
    colors.set(segment.id, color);
    used.add(color);
  }
  return colors;
}

// Map wall-clock timestamps onto the union of recorded running spans. Parallel
// executions share elapsed time, and idle gaps occupy no horizontal space.
export function createSessionRuntimeAxis(intervals) {
  const runs = [];
  for (const [start, end] of intervals.filter(span => Array.isArray(span) &&
      Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[1] >= span[0])
    .map(span => span.slice(0, 2)).sort((a, b) => a[0] - b[0])) {
    const previous = runs.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else runs.push({ start, end, elapsed: 0 });
  }
  let durationMs = 0;
  for (const run of runs) {
    run.elapsed = durationMs;
    durationMs += run.end - run.start;
  }
  return {
    durationMs,
    elapsedAt(at) {
      if (!Number.isFinite(at)) return null;
      let left = 0, right = runs.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (runs[middle].start <= at) left = middle + 1;
        else right = middle;
      }
      const run = runs[left - 1];
      return run ? run.elapsed + Math.min(at, run.end) - run.start : 0;
    },
  };
}

const linearized = segment => segment.linearized === true || /^linear(?:-|$)/.test(textValue(segment.interpolation));

function tooltip(owner) {
  const node = element('div', 'chart-tooltip');
  node.id = `usage-chart-tooltip-${++tooltipSequence}`;
  node.hidden = true;
  node.setAttribute('role', 'tooltip');
  node.style.position = 'fixed';
  owner.append(node);
  let target = null;

  const hide = () => {
    node.hidden = true;
    target?.classList.remove('chart-active-target');
    target?.removeAttribute('aria-describedby');
    target = null;
    if (activeTooltip?.node === node) activeTooltip = null;
  };
  const position = event => {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = Number.isFinite(event?.clientX) ? event.clientX : rect.left + rect.width / 2;
    const y = Number.isFinite(event?.clientY) ? event.clientY : rect.bottom;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 1024;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 768;
    const width = node.offsetWidth || 280;
    const height = node.offsetHeight || 180;
    node.style.left = `${Math.max(10, Math.min(x + 14, viewportWidth - width - 10))}px`;
    node.style.top = `${Math.max(10, Math.min(y + 14 + height > viewportHeight ? y - height - 14 : y + 14, viewportHeight - height - 10))}px`;
  };
  const show = (nextTarget, content, event) => {
    if (activeTooltip && activeTooltip.node !== node) activeTooltip.hide();
    if (target !== nextTarget) {
      target?.classList.remove('chart-active-target');
      target?.removeAttribute('aria-describedby');
    }
    target = nextTarget;
    node.replaceChildren(element('strong', 'chart-tooltip-title', content.title));
    for (const [label, value] of content.rows) {
      const row = element('div', 'chart-tooltip-row');
      row.append(element('span', 'chart-tooltip-label', label), element('span', 'chart-tooltip-value', value));
      node.append(row);
    }
    if (content.note) node.append(element('p', 'chart-tooltip-note', content.note));
    target.classList.add('chart-active-target');
    target.setAttribute('aria-describedby', node.id);
    node.hidden = false;
    activeTooltip = { node, owner, hide };
    position(event);
  };
  if (!tooltipEventsBound) {
    tooltipEventsBound = true;
    window.addEventListener('scroll', () => activeTooltip?.hide(), true);
    window.addEventListener('resize', () => activeTooltip?.hide());
    document.addEventListener('keydown', event => { if (event.key === 'Escape') activeTooltip?.hide(); });
    document.addEventListener('pointerdown', event => {
      if (activeTooltip && !activeTooltip.owner.contains(event.target)) activeTooltip.hide();
    });
  }
  return {
    bind(control, content, activate) {
      control.setAttribute('aria-label', [content.title, ...content.rows.map(row => row.join('：')), content.note].filter(Boolean).join('；'));
      control.addEventListener('pointerenter', event => show(control, content, event));
      control.addEventListener('pointermove', event => { if (target === control) position(event); });
      control.addEventListener('pointerleave', () => { if (document.activeElement !== control && target === control) hide(); });
      control.addEventListener('focus', () => show(control, content));
      control.addEventListener('blur', () => { if (target === control) hide(); });
      control.addEventListener('click', event => {
        show(control, content, event);
        if (activate) activate();
      });
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          show(control, content);
          if (activate) activate();
        }
      });
    },
  };
}

function pathData(points, x, y, key = 'value') {
  let drawing = false;
  return points.map(point => {
    if (point[key] === null) { drawing = false; return ''; }
    const command = drawing ? 'L' : 'M';
    drawing = true;
    return `${command}${x(point.at).toFixed(2)},${y(point[key]).toFixed(2)}`;
  }).join(' ');
}

function addAxes(svg, { width, height, padding, maximum, firstAt, lastAt, label }) {
  const innerHeight = height - padding.top - padding.bottom;
  for (const fraction of [0, 0.5, 1]) {
    const y = padding.top + innerHeight * fraction;
    svg.append(svgElement('line', { x1: padding.left, x2: width - padding.right, y1: y, y2: y, class: 'chart-grid-line' }));
    svg.append(svgElement('text', { x: padding.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'chart-axis-label' }, label(maximum * (1 - fraction))));
  }
  svg.append(svgElement('text', { x: padding.left, y: height - 8, class: 'chart-axis-label' }, formatTime(firstAt)));
  if (lastAt !== firstAt) svg.append(svgElement('text', { x: width - padding.right, y: height - 8, 'text-anchor': 'end', class: 'chart-axis-label' }, formatTime(lastAt)));
}

/** A task's cumulative consumption, with one independently identifiable color per execution. */
export function createSessionChart(chart, { id = '', preferenceKey = id, formatPercent = percent, formatDuration = duration } = {}) {
  const container = element('div', 'session-chart');
  container.setAttribute('role', 'group');
  const tokenUnit = chart?.unit === 'tokens' || chart?.unit === 'token';
  const amount = tokenUnit ? tokens : formatPercent;
  const segments = (Array.isArray(chart?.segments) ? chart.segments : []).filter(record).map((segment, index) => ({
    ...segment,
    id: textValue(segment.id, textValue(segment.turnId, `${id}:execution:${segment.startedAt ?? index}`)),
    started: timestamp(segment.startedAt),
    completed: timestamp(segment.completedAt),
    points: (Array.isArray(segment.points) ? segment.points : []).filter(record)
      .map(point => ({ at: timestamp(point.at), value: nonnegative(point.value) }))
      .filter(point => point.at !== null && point.value !== null).sort((a, b) => a.at - b.at),
  })).sort((a, b) => (a.started ?? a.points[0]?.at ?? 0) - (b.started ?? b.points[0]?.at ?? 0));
  const plotted = segments.filter(segment => segment.points.length);
  container.setAttribute('aria-label', tokenUnit ? '任务累计 token 消耗，每种颜色代表一次执行' : '任务累计额度消耗，每种颜色代表一次执行');
  if (!plotted.length) {
    container.append(element('p', 'session-chart-empty', '暂无可绘制的执行记录'));
    return container;
  }
  const points = plotted.flatMap(segment => segment.points);
  const firstAt = Math.min(...points.map(point => point.at));
  const lastAt = Math.max(...points.map(point => point.at));
  const rawMaximum = Math.max(0, ...points.map(point => point.value));
  const maximum = rawMaximum > 0 ? rawMaximum * 1.12 : 1;
  const colors = colorsFor(String(id || plotted[0].taskId || plotted[0].id), segments);
  const runtime = createSessionRuntimeAxis(plotted.flatMap(segment => Array.isArray(segment.runningIntervals)
    ? segment.runningIntervals : [[segment.points[0].at, segment.points.at(-1).at]]));
  const storageKey = SESSION_CHART_KEY + encodeURIComponent(String(preferenceKey || id || plotted[0].taskId || plotted[0].id));
  if (!sessionChartPreferences.has(storageKey)) sessionChartPreferences.set(storageKey, readPreference(storageKey, ['true', 'false'], 'false') === 'true');
  let expanded = sessionChartPreferences.get(storageKey);
  const plot = element('div', 'session-chart-plot');
  plot.id = `session-chart-plot-${++sessionChartSequence}`;
  const toggle = element('button', 'session-chart-toggle');
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-controls', plot.id);
  container.append(plot, toggle);
  const popup = tooltip(container);
  const draw = () => {
    if (activeTooltip?.owner === container) activeTooltip.hide();
    container.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '收起折线图' : '展开折线图';
    const width = expanded ? Math.max(320, Math.min(1100, (byId('sessionList')?.clientWidth || 500) - 50)) : 176;
    const height = expanded ? 118 : 60;
    const padding = expanded ? { top: 10, right: 12, bottom: 24, left: tokenUnit ? 54 : 52 }
      : { top: 6, right: 6, bottom: 6, left: 6 };
    const x = at => padding.left + (runtime.durationMs > 0 ? runtime.elapsedAt(at) / runtime.durationMs : 0.5) * (width - padding.left - padding.right);
    const y = value => padding.top + (1 - value / maximum) * (height - padding.top - padding.bottom);
    const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, class: 'session-chart-svg', role: 'group', 'aria-label': container.getAttribute('aria-label') });
    svg.append(svgElement('title', {}, '横轴按累计运行时长排列；首尾标记真实时间，悬停或聚焦可查看实际时间、耗时和消耗'));
    if (expanded) addAxes(svg, { width, height, padding, maximum, firstAt, lastAt, label: tokenUnit ? value => {
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
      return Math.round(value).toLocaleString('zh-CN');
    } : formatPercent });

    plotted.forEach((segment, index) => {
      const color = colors.get(segment.id);
      const notes = [linearized(segment) ? '轮次内曲线按执行起止时间线性估算；耗时以实际执行记录为准。' : '',
        tokenUnit && segment.durationScope === 'full-turn' && ['provider-observed', 'provider-prefix'].includes(segment.usageScope)
          ? '耗时为整轮执行，token 仅包含当前供应商已记录部分。' : '',
        !tokenUnit ? '额度为会话归因估算。' : '', chart?.partial ? '仅包含可用的历史记录。' : ''].filter(Boolean).join('');
      const rows = [
        [segment.durationScope === 'observed-intervals' ? '已观察时长' : '实际执行耗时', formatDuration(segment.elapsedSeconds, '未记录')],
        [tokenUnit ? '本次 token 消耗' : '本次消耗', amount(segment.amount)],
        ...(!tokenUnit ? [['平均每 1% 耗时', formatDuration(segment.secondsPerPercent, '待估算')]] : []),
        ['开始', formatTime(segment.started, true)],
        ['结束', segment.completed === null ? '执行中 / 未记录结束' : formatTime(segment.completed, true)],
      ];
      const content = { title: `第 ${index + 1} 次执行${segment.title ? ` · ${segment.title}` : ''}`, rows, note: notes };
      const group = svgElement('g', { class: 'chart-interaction session-chart-segment', tabindex: '0', role: 'img', 'data-segment-id': segment.id });
      group.style.setProperty('--execution-color', color);
      const d = pathData(segment.points, x, y);
      group.append(svgElement('path', { d, class: 'session-chart-line', fill: 'none', stroke: color, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }),
        svgElement('path', { d, class: 'chart-hit-target', fill: 'none', stroke: 'transparent', 'stroke-width': 14, 'pointer-events': 'stroke', 'vector-effect': 'non-scaling-stroke' }));
      popup.bind(group, content);
      svg.append(group);
      for (const point of segment.points) {
        const control = svgElement('g', { class: 'chart-interaction session-chart-point-control', tabindex: '0', role: 'img', 'data-segment-id': segment.id });
        control.style.setProperty('--execution-color', color);
        control.append(svgElement('circle', { cx: x(point.at), cy: y(point.value), r: expanded ? 3 : 2, fill: color, class: 'session-chart-point' }),
          svgElement('circle', { cx: x(point.at), cy: y(point.value), r: expanded ? 8 : 5, fill: 'transparent', class: 'chart-hit-target', 'pointer-events': 'all' }));
        popup.bind(control, { ...content, rows: [['实际时间', formatTime(point.at, true)], ['任务累计消耗', amount(point.value)], ...rows] });
        svg.append(control);
      }
    });
    plot.replaceChildren(svg);
    if (expanded) {
      plot.append(element('p', 'session-chart-caption', ['横轴为累计运行时长；首尾标记真实时间', chart?.partial ? '仅含可用记录' : '',
        plotted.some(linearized) ? '轮次内走势为线性估算' : ''].filter(Boolean).join(' · ')));
    }
  };
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    sessionChartPreferences.set(storageKey, expanded);
    savePreference(storageKey, String(expanded));
    draw();
  });
  draw();
  return container;
}

function normalizeTrend(snapshot) {
  return (Array.isArray(snapshot?.quotaTrend?.points) ? snapshot.quotaTrend.points : []).filter(record).map((point, index) => {
    const at = timestamp(point.at);
    const remaining = nonnegative(point.remainingPercent);
    return {
      ...point, at,
      id: textValue(point.id, `${at}:${point.cumulativePercent ?? ''}:${point.remainingPercent ?? ''}:${index}`),
      remainingPercent: remaining !== null && remaining <= 100 ? remaining : null,
      cumulativePercent: nonnegative(point.cumulativePercent), estimatedPercent: nonnegative(point.estimatedPercent),
      unattributedPercent: nonnegative(point.unattributedPercent), deltaPercent: number(point.deltaPercent), reset: point.reset === true,
    };
  }).filter(point => point.at !== null).sort((a, b) => a.at - b.at);
}

function contributorRows(point) {
  const consumed = nonnegative(point.deltaPercent);
  const merged = new Map();
  for (const [index, contributor] of (Array.isArray(point.contributors) ? point.contributors : []).entries()) {
    if (!record(contributor)) continue;
    const unattributed = contributor.kind === 'unattributed' || contributor.unattributed === true || /(^|[-_:])unattributed($|[-_:])/i.test(textValue(contributor.id)) || contributor.title === '未归因';
    const id = unattributed ? 'unattributed' : textValue(contributor.id, `contributor:${index}`);
    const supplied = nonnegative(contributor.percent);
    const share = nonnegative(contributor.sharePercent);
    const value = supplied ?? (consumed !== null && share !== null ? consumed * share / 100 : null);
    if (value === null) continue;
    const previous = merged.get(id);
    merged.set(id, { id, title: unattributed ? '未归因' : textValue(contributor.title, '未命名会话'), percent: value + (previous?.percent || 0) });
  }
  const known = [...merged.values()].filter(row => row.id !== 'unattributed').reduce((sum, row) => sum + row.percent, 0);
  const unknown = Math.max(merged.get('unattributed')?.percent || 0, consumed === null ? 0 : consumed - known);
  merged.set('unattributed', { id: 'unattributed', title: '未归因', percent: Math.max(0, unknown) });
  const rows = [...merged.values()].sort((a, b) => b.percent - a.percent || a.title.localeCompare(b.title, 'zh-CN'));
  const total = rows.reduce((sum, row) => sum + row.percent, 0);
  if (total <= 0) return { rows: [], total, normalized: false };
  let allocated = 0;
  rows.forEach(row => { const exact = row.percent / total * 10000; row.share = Math.floor(exact); row.remainder = exact - row.share; allocated += row.share; });
  const remainders = [...rows].sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < 10000 - allocated; index += 1) remainders[index % remainders.length].share += 1;
  return { rows, total, normalized: consumed !== null && Math.abs(total - consumed) > 0.00001 };
}

function renderTrendDetails() {
  const container = byId('trendDetails');
  if (!container) return;
  if (!selectedPoint) {
    container.replaceChildren(element('p', 'trend-details-empty', '点击或按 Enter 选择一个采样点，查看此次消耗的会话明细。'));
    return;
  }
  const point = selectedPoint;
  let details = container.querySelector('details');
  let heading = container.querySelector('.trend-point-summary');
  if (!details || !heading) {
    heading = element('div', 'trend-point-summary');
    details = element('details', 'trend-contributors-details');
    details.append(element('summary'), element('div', 'trend-contributors'), element('p', 'trend-detail-note'));
    details.open = detailsOpen;
    details.addEventListener('toggle', () => { detailsOpen = details.open; });
    container.replaceChildren(heading, details);
  }
  const selectedValue = trendMode === 'remaining' ? point.remainingPercent : point.cumulativePercent;
  heading.replaceChildren(element('span', '', formatTime(point.at, true)), element('strong', '', `${trendMode === 'remaining' ? '官方剩余' : '累计已观察'} ${percent(selectedValue)}`));
  if (point.reset) heading.append(element('span', 'trend-reset-badge', '额度重置'));
  const delta = point.deltaPercent;
  details.querySelector('summary').textContent = delta !== null && delta >= 0 ? `此次 ${percent(delta)} 的会话明细` : '此次额度记录的会话明细';
  details.dataset.pointId = point.id;
  const list = details.querySelector('.trend-contributors');
  list.replaceChildren();
  const { rows, normalized } = contributorRows(point);
  if (rows.length) {
    list.setAttribute('role', 'table');
    list.setAttribute('aria-label', '此次消耗的会话占比，合计 100%');
    const header = element('div', 'trend-contributor-row trend-contributor-head');
    header.setAttribute('role', 'row');
    for (const value of ['会话', '消耗', '本次占比']) { const cell = element('span', '', value); cell.setAttribute('role', 'columnheader'); header.append(cell); }
    list.append(header);
    rows.forEach(row => {
      const line = element('div', 'trend-contributor-row');
      line.setAttribute('role', 'row');
      line.dataset.contributorId = row.id;
      for (const [className, value] of [['trend-contributor-name', row.title], ['trend-contributor-amount', percent(row.percent)], ['trend-contributor-share', `${(row.share / 100).toFixed(2)}%`]]) {
        const cell = element('span', className, value); cell.setAttribute('role', 'cell'); line.append(cell);
      }
      list.append(line);
    });
  } else {
    list.removeAttribute('role');
    list.removeAttribute('aria-label');
    list.append(element('p', 'trend-details-empty', point.reset ? '此次记录为额度重置，未观察到新增消耗。' : '此次采样未记录可分配的新增消耗。'));
  }
  details.querySelector('.trend-detail-note').textContent = normalized
    ? '会话归因为估算；明细合计与官方变化有差异，占比按明细合计计算。'
    : '明细对应此次实际观察到的额度变化；会话归因为估算，未归因部分单独列出。';
}

function trendTooltip(point, label) {
  const rows = [['采样时间', formatTime(point.at, true)]];
  if (point.remainingPercent !== null) rows.push(['官方剩余', percent(point.remainingPercent)]);
  if (point.cumulativePercent !== null) rows.push(['累计已观察', percent(point.cumulativePercent)]);
  if (point.estimatedPercent !== null) rows.push(['累计会话估算', percent(point.estimatedPercent)]);
  if (point.unattributedPercent !== null) rows.push(['累计未归因', percent(point.unattributedPercent)]);
  if (point.deltaPercent !== null) rows.push([point.deltaPercent < 0 ? '本次额度调整' : '本次观察消耗', percent(point.deltaPercent)]);
  return { title: `${label}${point.reset ? ' · 额度重置' : ''}`, rows, note: '点击或按 Enter 保留此次会话明细。' };
}

/** Render only genuine account samples; quota jumps are never split into invented 1% events. */
export function renderQuotaTrend(snapshot) {
  latestTrendSnapshot = snapshot;
  const chart = byId('trendChart');
  if (!chart) return;
  trendMode ??= readPreference(MODE_KEY, ['remaining', 'cumulative'], 'remaining');
  if (!selectionInitialized) { selectedPointId = readPreference(POINT_KEY, null, null); selectionInitialized = true; }
  const control = byId('trendMode');
  if (control) {
    control.value = trendMode;
    if (!boundModes.has(control)) {
      boundModes.add(control);
      control.addEventListener('change', () => {
        trendMode = control.value === 'cumulative' ? 'cumulative' : 'remaining';
        savePreference(MODE_KEY, trendMode);
        renderQuotaTrend(latestTrendSnapshot);
      });
    }
  }
  const focused = chart.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.getAttribute('data-trend-point-id');
  const focusSeries = focused?.getAttribute('data-trend-series');
  if (activeTooltip?.owner === chart) activeTooltip.hide();
  chart.replaceChildren();
  chart.dataset.mode = trendMode;
  chart.setAttribute('role', 'group');
  chart.setAttribute('aria-label', trendMode === 'remaining' ? '官方剩余额度趋势，纵轴 0% 到 100%' : '累计额度消耗趋势，可跨多个额度周期');
  const series = trendMode === 'remaining'
    ? [{ key: 'remainingPercent', label: '官方剩余', className: 'trend-line-observed' }]
    : [{ key: 'cumulativePercent', label: '已观察', className: 'trend-line-observed' },
      { key: 'estimatedPercent', label: '会话估算', className: 'trend-line-estimated' },
      { key: 'unattributedPercent', label: '未归因', className: 'trend-line-unattributed' }];
  const section = byId('trendSection');
  const legend = byId('trendLegend') || section?.querySelector('.trend-legend');
  if (legend) {
    legend.replaceChildren();
    for (const item of series) {
      const entry = element('span');
      const swatch = element('i', `trend-legend-line ${item.className.replace('trend-line-', 'trend-legend-line-')}`);
      swatch.setAttribute('aria-hidden', 'true');
      entry.append(swatch, document.createTextNode(item.label)); legend.append(entry);
    }
  }
  const caption = byId('trendCaption') || section?.querySelector('.chart-caption');
  if (caption) caption.textContent = trendMode === 'remaining'
    ? '官方剩余额度按时间排列；重置会使曲线回升。悬停看读数，点击看本次消耗明细。'
    : '三条线累计已观察、会话估算与未归因消耗，可超过 100%。点击采样点查看对应变化的明细。';
  const allPoints = normalizeTrend(snapshot);
  const refreshedSelection = allPoints.find(point => point.id === selectedPointId);
  if (refreshedSelection) selectedPoint = refreshedSelection;
  const points = allPoints.filter(point => series.some(item => point[item.key] !== null));
  if (!points.length) {
    chart.append(element('div', 'empty-state chart-empty', '尚无额度样本 · 完成官方额度读取后会出现'));
    setText('trendLatest', '等待额度样本');
    renderTrendDetails();
    return;
  }
  const firstAt = points[0].at;
  const last = points.at(-1);
  const maximum = trendMode === 'remaining' ? 100 : Math.max(1, ...points.flatMap(point => series.map(item => point[item.key] || 0))) * 1.12;
  const width = Math.max(260, Math.min(960, chart.clientWidth || 680));
  const height = 240;
  const padding = { top: 26, right: 18, bottom: 34, left: 57 };
  const x = at => padding.left + (last.at > firstAt ? (at - firstAt) / (last.at - firstAt) : 0.5) * (width - padding.left - padding.right);
  const y = value => padding.top + (1 - value / maximum) * (height - padding.top - padding.bottom);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': chart.getAttribute('aria-label') });
  svg.append(svgElement('title', {}, chart.getAttribute('aria-label')));
  addAxes(svg, { width, height, padding, maximum, firstAt, lastAt: last.at, label: percent });
  let lastResetLabelX = -Infinity;
  for (const point of points.filter(point => point.reset)) {
    const resetX = x(point.at);
    svg.append(svgElement('line', { x1: resetX, x2: resetX, y1: padding.top - 4, y2: height - padding.bottom, class: 'chart-reset-marker' }));
    if (resetX - lastResetLabelX >= 42) {
      svg.append(svgElement('text', { x: resetX, y: 12, 'text-anchor': resetX > width - 50 ? 'end' : 'start', class: 'chart-axis-label chart-reset-label' }, '重置'));
      lastResetLabelX = resetX;
    }
  }
  const popup = tooltip(chart);
  let restoreFocus = null;
  const pointControls = [];
  const select = point => {
    selectedPointId = point.id;
    selectedPoint = point;
    detailsOpen = true;
    savePreference(POINT_KEY, point.id);
    for (const node of pointControls) {
      const selected = node.getAttribute('data-trend-point-id') === point.id;
      node.classList.toggle('trend-selected-point', selected);
      node.setAttribute('aria-pressed', String(selected));
    }
    renderTrendDetails();
    const details = byId('trendDetails')?.querySelector('details');
    if (details) details.open = true;
  };
  for (const item of series) {
    svg.append(svgElement('path', { d: pathData(points, x, y, item.key), class: `trend-line ${item.className}`, fill: 'none', 'aria-hidden': 'true', 'pointer-events': 'none' }));
    const controls = [];
    for (const point of points) {
      if (point[item.key] === null) continue;
      const selected = point.id === selectedPointId;
      const node = svgElement('g', { class: `chart-interaction trend-point-control${selected ? ' trend-selected-point' : ''}`, tabindex: '0', role: 'button',
        'aria-pressed': selected, 'aria-controls': 'trendDetails', 'data-trend-point-id': point.id, 'data-trend-series': item.key });
      node.append(svgElement('circle', { cx: x(point.at), cy: y(point[item.key]), r: 3.5, class: `trend-point ${item.className}` }),
        svgElement('circle', { cx: x(point.at), cy: y(point[item.key]), r: 9, fill: 'transparent', class: 'chart-hit-target', 'pointer-events': 'all' }));
      popup.bind(node, trendTooltip(point, item.label), () => select(point));
      const index = controls.length;
      node.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : null;
        if (next !== null) { event.preventDefault(); controls[Math.max(0, Math.min(next, controls.length - 1))]?.focus(); }
      });
      controls.push(node); pointControls.push(node); svg.append(node);
      if (point.id === focusId && item.key === focusSeries) restoreFocus = node;
    }
  }
  chart.prepend(svg);
  setText('trendLatest', `${formatTime(last.at)} · ${trendMode === 'remaining' ? `剩余 ${percent(last.remainingPercent)}` : `累计已观察 ${percent(last.cumulativePercent)}`}`);
  renderTrendDetails();
  if (restoreFocus) restoreFocus.focus({ preventScroll: true });
}

/** Switch the complete attribution presentation together, without mixing statistics scopes. */
export function renderAttributionScopes(snapshot) {
  latestAttributionSnapshot = snapshot;
  attributionScope ??= readPreference(SCOPE_KEY, ['history', 'current'], 'history');
  const control = byId('attributionScope');
  if (control) {
    control.value = attributionScope;
    if (!boundScopes.has(control)) {
      boundScopes.add(control);
      control.addEventListener('change', () => {
        attributionScope = control.value === 'current' ? 'current' : 'history';
        savePreference(SCOPE_KEY, attributionScope);
        renderAttributionScopes(latestAttributionSnapshot);
      });
    }
  }
  const scoped = snapshot?.attributionScopes?.[attributionScope];
  const attribution = record(scoped) ? scoped : attributionScope === 'history' && record(snapshot?.attribution) ? snapshot.attribution : {};
  const observed = nonnegative(attribution.observedPercent);
  const estimated = nonnegative(attribution.estimatedPercent);
  const unattributed = nonnegative(attribution.unattributedPercent);
  const incomplete = /lower-bound/.test(textValue(attribution.estimatedPercentCoverage));
  const ratio = !incomplete && observed !== null && observed > 0 && estimated !== null ? Math.min(100, estimated / observed * 100) : null;
  setText('attributionTotal', ratio === null ? incomplete ? '等待完整记录' : observed === 0 ? '等待额度变化' : '等待采样' : percent(ratio));
  byId('attributionTotal')?.classList.toggle('attribution-status', ratio === null);
  const barMaximum = Math.max(100, observed || 0, estimated || 0, unattributed || 0);
  for (const [prefix, value] of [['observed', observed], ['estimated', estimated], ['unattributed', unattributed]]) {
    const available = value !== null && (!incomplete || prefix === 'observed');
    setText(`${prefix}Percent`, available ? percent(value) : incomplete ? '记录不完整' : '等待采样');
    const bar = byId(`${prefix}Bar`);
    if (!bar) continue;
    bar.hidden = !available;
    bar.style.width = available ? `${Math.max(0, Math.min(100, value / barMaximum * 100))}%` : '0%';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(barMaximum));
    if (available) { bar.setAttribute('aria-valuenow', String(value)); bar.setAttribute('aria-valuetext', percent(value)); }
    else { bar.removeAttribute('aria-valuenow'); bar.removeAttribute('aria-valuetext'); }
  }
  const since = timestamp(attribution.since);
  setText('attributionSince', since !== null ? `${attribution.startKnown === false ? '已记录自' : '从'} ${formatTime(since)}` : '等待样本');
  setText('attributionWindow', textValue(attribution.windowLabel, attributionScope === 'current' ? '当前官方额度周期' : '监控历史累计'));
  setText('attributionNote', [
    attributionScope === 'history' ? '按监控历史累计，跨周期消耗可超过 100%。' : '仅统计当前官方额度周期。',
    attributionScope === 'current' && attribution.startKnown === false ? '周期起点尚未确认，以上仅包含已记录部分。' : '',
    attribution.excludedIncompleteHistory === true ? '已跳过较早的不完整记录，从标注时间起计算。' : '',
    incomplete ? '会话记录不完整，已归因比例暂不可计算。' : '',
    '会话归因为估算，未归因消耗可能来自其他设备或缺失记录。',
  ].join(''));
}
