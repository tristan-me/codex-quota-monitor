(() => {
  'use strict';

  const API_SNAPSHOT = '/api/snapshot';
  const API_SETTINGS = '/api/settings';
  const DISCLAIMER_KEY = 'codexQuotaMonitor.disclaimerDismissed';
  const OBJECTIVES = new Set(['economy', 'balanced', 'quality']);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = {
    snapshot: null,
    error: null,
    lastSettingsError: null,
    fetching: false,
    lastUpdatedAt: null,
    pollTimer: null,
    settingsQueue: Promise.resolve(),
    settingsSaving: false,
    restoreSaving: false,
    disclaimerSaving: false,
    reminderSaving: false,
    compact: false,
    resetBaseSeconds: null,
    resetBaseAt: null,
    resetScheduledAt: null,
    exhaustionAt: null,
    lastFocusBeforeModal: null,
  };

  const $ = (id) => document.getElementById(id);

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function finiteNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function boundedNumber(value, fallback, min, max) {
    const parsed = finiteNumber(value);
    if (parsed === null) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function safeText(value, fallback = '—') {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  function safeError(value, fallback = '未知错误') {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (isRecord(value)) {
      return safeText(value.message || value.error || value.detail, fallback);
    }
    return fallback;
  }

  function clampPercent(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? null : Math.min(100, Math.max(0, parsed));
  }

  function formatPercent(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? '—' : `${parsed.toFixed(3)}%`;
  }

  function formatCredits(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? '—' : parsed.toFixed(3);
  }

  function formatDuration(value, empty = '等待采样') {
    const parsed = finiteNumber(value);
    if (parsed === null || parsed < 0) return empty;
    const totalSeconds = Math.floor(parsed);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}小时 ${minutes}分钟 ${seconds}秒`;
    return `${minutes}分钟 ${seconds}秒`;
  }

  function formatShortDuration(value, empty = '等待数据') {
    const parsed = finiteNumber(value);
    if (parsed === null) return empty;
    if (parsed < 0) return '已到期';
    const totalSeconds = Math.ceil(parsed);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    if (minutes > 0) return `${minutes}分 ${seconds}秒`;
    return `${seconds}秒`;
  }

  function parseDate(value) {
    const numeric = finiteNumber(value);
    if (numeric !== null) {
      if (numeric <= 0) return null;
      const milliseconds = Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, fallback = '—') {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return fallback;
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function formatUpdated(value) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return '尚未同步';
    return `更新于 ${formatDate(date)}`;
  }

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = safeText(value, '');
    return element;
  }

  function setText(id, value, fallback = '—') {
    const element = $(id);
    if (element) element.textContent = safeText(value, fallback);
  }

  function setHidden(idOrElement, hidden) {
    const element = typeof idOrElement === 'string' ? $(idOrElement) : idOrElement;
    if (element) element.hidden = Boolean(hidden);
  }

  function getTokenFromHash() {
    const rawHash = typeof window.location.hash === 'string' ? window.location.hash.slice(1) : '';
    if (!rawHash) return '';
    const parameters = new URLSearchParams(rawHash);
    const namedToken = parameters.get('token') || parameters.get('quotaToken');
    if (namedToken) return namedToken.trim();
    if (!rawHash.includes('=') && !rawHash.includes('&')) {
      try {
        return decodeURIComponent(rawHash).trim();
      } catch (_error) {
        return rawHash.trim();
      }
    }
    return '';
  }

  function requestHeaders(extra = {}) {
    const headers = new Headers(extra);
    headers.set('Accept', 'application/json');
    const token = getTokenFromHash();
    if (token) headers.set('X-Quota-Token', token);
    return headers;
  }

  function getSettings(snapshot) {
    const source = isRecord(snapshot) && isRecord(snapshot.settings) ? snapshot.settings : {};
    const objective = OBJECTIVES.has(source.objective) ? source.objective : 'balanced';
    return {
      pollSeconds: boundedNumber(source.pollSeconds, 5, 2, 300),
      quotaPollSeconds: boundedNumber(source.quotaPollSeconds, 30, 5, 3600),
      paused: source.paused === true,
      autoSwitch: source.autoSwitch === true,
      hideDisclaimer: source.hideDisclaimer === true,
      objective,
    };
  }

  function sessionsFrom(snapshot) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return null;
    return snapshot.sessions.filter((session) => isRecord(session));
  }

  function isActiveStatus(status) {
    const normalized = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['running', 'active', 'thinking', 'in_progress', 'inprogress', 'processing', 'working', 'started', 'pending', 'queued'].includes(normalized);
  }

  function isUnknownStatus(status) {
    if (status === null || status === undefined || String(status).trim() === '') return true;
    return ['unknown', 'unavailable', 'indeterminate'].includes(String(status).toLowerCase());
  }

  function isRootSession(session) {
    if (session.isRoot === false) return false;
    const parentIdMissing = session.parentId === null || session.parentId === undefined || session.parentId === '';
    const parentSessionIdMissing = session.parentSessionId === null || session.parentSessionId === undefined || session.parentSessionId === '';
    return parentIdMissing && parentSessionIdMissing;
  }

  function statusLabel(status) {
    const normalized = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
    const labels = {
      running: '运行中',
      active: '运行中',
      thinking: '思考中',
      in_progress: '处理中',
      processing: '处理中',
      working: '工作中',
      queued: '排队中',
      pending: '排队中',
      started: '运行中',
      inprogress: '处理中',
      idle: '待机',
      completed: '已完成',
      complete: '已完成',
      failed: '失败',
      cancelled: '已取消',
      canceled: '已取消',
      paused: '已暂停',
      unknown: '未知',
    };
    return labels[normalized] || (normalized ? safeText(status) : '未知');
  }

  function statusClass(status) {
    const normalized = String(status || '').toLowerCase();
    if (isActiveStatus(normalized)) return 'status-running';
    if (normalized.includes('fail') || normalized.includes('cancel')) return 'status-failed';
    if (normalized === 'completed' || normalized === 'complete') return 'status-complete';
    return 'status-unknown';
  }

  function confidenceLabel(value) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    const parsed = finiteNumber(value);
    if (parsed === null) return '';
    const percentage = parsed <= 1 ? parsed * 100 : parsed;
    return `置信度 ${percentage.toFixed(1)}%`;
  }

  function summaryStatus(snapshot) {
    const sessions = sessionsFrom(snapshot);
    if (!sessions) return '等待会话样本';
    const active = sessions.filter((session) => isRootSession(session) && isActiveStatus(session.status)).length;
    if (active === 0) return '当前没有活跃根会话';
    return `${active} 个活跃根会话正在采样`;
  }

  function renderConnection(snapshot) {
    const pill = $('connectionPill');
    const text = $('connectionText');
    const refresh = $('refreshBtn');
    if (!pill || !text) return;
    pill.classList.remove('is-loading', 'is-error', 'is-ready');
    if (state.fetching) {
      pill.classList.add('is-loading');
      text.textContent = '同步中';
    } else if (state.error) {
      pill.classList.add('is-error');
      text.textContent = '连接异常';
    } else if (state.snapshot) {
      pill.classList.add('is-ready');
      text.textContent = '已连接';
    } else {
      pill.classList.add('is-loading');
      text.textContent = '等待连接';
    }
    if (refresh) refresh.disabled = state.fetching;
    const settings = getSettings(snapshot);
    const updated = formatUpdated(state.lastUpdatedAt || (isRecord(snapshot) ? snapshot.now : null));
    const accountError = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account.error : null;
    const status = state.error ? '连接异常' : accountError ? '账户额度读取异常' : state.fetching ? '读取本地快照' : '已连接';
    const statusText = `${status} · 本地每 ${settings.pollSeconds} 秒刷新 · ${updated}${settings.paused ? ' · 远程额度暂停' : ''}`;
    setText('globalStatus', statusText, '等待连接');
    setText('compactStatusText', statusText, '等待连接');
  }

  function renderGlobalError(snapshot) {
    const element = $('globalError');
    const message = $('globalErrorText');
    if (!element || !message) return;
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : null;
    const visibleError = state.error || (account && account.error ? safeError(account.error, '') : '');
    if (!visibleError) {
      element.hidden = true;
      return;
    }
    message.textContent = state.error
      ? `无法读取最新本地快照：${safeError(state.error)}`
      : `账户额度暂不可用：${safeError(visibleError)}`;
    element.hidden = false;
  }

  function renderOverview(snapshot) {
    const sessions = sessionsFrom(snapshot);
    const activeCountSource = finiteNumber(isRecord(snapshot) ? snapshot.activeRootCount : null);
    const unknownCountSource = finiteNumber(isRecord(snapshot) ? (snapshot.unknownSessionCount ?? snapshot.sessionsUnknown) : null);
    if (!sessions && activeCountSource === null) {
      setText('activeSessionCount', '—', '—');
      setText('activeSessionDetail', '等待会话数据', '等待会话数据');
      setText('unknownSessionCount', '—', '—');
      setText('unknownSessionDetail', '等待快照', '等待快照');
    } else {
      const activeCount = activeCountSource === null
        ? sessions.filter((session) => isRootSession(session) && isActiveStatus(session.status)).length
        : Math.max(0, Math.round(activeCountSource));
      const unknownCount = unknownCountSource === null
        ? (sessions ? sessions.filter((session) => isUnknownStatus(session.status)).length : null)
        : Math.max(0, Math.round(unknownCountSource));
      setText('activeSessionCount', String(activeCount), '—');
      setText('activeSessionDetail', sessions && sessions.length ? `${sessions.length} 个会话纳入快照` : '当前没有活跃会话', '当前没有活跃会话');
      setText('unknownSessionCount', unknownCount === null ? '—' : String(unknownCount), '—');
      setText('unknownSessionDetail', unknownCount === null ? '等待状态字段' : unknownCount > 0 ? '状态或会话信息缺失' : '状态均已识别', '等待状态字段');
    }

    const attribution = isRecord(snapshot) && isRecord(snapshot.attribution) ? snapshot.attribution : {};
    const estimated = finiteNumber(attribution.estimatedPercent);
    setText('estimatedTotal', estimated === null ? '—' : formatPercent(estimated), '—');
    setText('estimatedTotalDetail', estimated === null ? '等待归因样本' : safeText(attribution.windowLabel, '会话归因估算'), '等待归因样本');

    const reset = isRecord(snapshot) && isRecord(snapshot.reset) ? snapshot.reset : {};
    const resetSeconds = finiteNumber(reset.secondsUntil);
    state.resetBaseSeconds = resetSeconds;
    state.resetBaseAt = resetSeconds === null ? null : Date.now();
    state.resetScheduledAt = reset.scheduledAt;
    state.exhaustionAt = reset.exhaustionAt;
    setText('nextResetValue', resetSeconds === null ? '—' : formatShortDuration(resetSeconds), '—');
    setText('nextResetDetail', resetSeconds === null ? '等待官方倒计时' : formatDate(reset.scheduledAt, '官方时间待定'), '等待官方倒计时');
  }

  function renderSessionList(snapshot) {
    const list = $('sessionList');
    if (!list) return;
    list.replaceChildren();
    const sessions = sessionsFrom(snapshot);
    setText('sessionSummaryText', summaryStatus(snapshot), '等待会话样本');
    const settings = getSettings(snapshot);
    setText('sessionRefreshHint', `每 ${settings.pollSeconds} 秒更新`, '每 5 秒更新');
    if (!sessions) {
      list.append(textElement('div', 'empty-state', '等待本地会话快照 · 不会虚构消耗数值'));
      return;
    }
    if (sessions.length === 0) {
      list.append(textElement('div', 'empty-state', '当前没有可显示会话 · 等待 Codex 活跃会话采样'));
      return;
    }
    sessions.forEach((session, index) => {
      const row = document.createElement('article');
      row.className = 'session-row';
      row.setAttribute('role', 'listitem');

      const header = document.createElement('div');
      header.className = 'session-row-header';
      const titleBlock = document.createElement('div');
      titleBlock.className = 'session-title-block';
      const title = textElement('h3', 'session-title', session.title || `未命名会话 ${index + 1}`);
      titleBlock.append(title);
      const identity = safeText(session.id, 'ID 未提供');
      titleBlock.append(textElement('span', 'session-id', identity));
      header.append(titleBlock);
      const status = textElement('span', `status-chip ${statusClass(session.status)}`, statusLabel(session.status));
      header.append(status);
      row.append(header);

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      const model = safeText(session.model, '模型待定');
      const effort = safeText(session.reasoningEffort, '推理强度待定');
      meta.append(textElement('span', 'meta-item', model));
      meta.append(textElement('span', 'meta-separator', '·'));
      meta.append(textElement('span', 'meta-item', effort));
      const childCount = finiteNumber(session.childCount);
      if (childCount !== null) {
        meta.append(textElement('span', 'meta-separator', '·'));
        meta.append(textElement('span', 'meta-item', `子会话 ${Math.max(0, Math.round(childCount))} 个`));
      }
      row.append(meta);

      const elapsed = finiteNumber(session.elapsedSeconds);
      const hasElapsedSample = elapsed !== null && elapsed > 0;
      const estimate = finiteNumber(session.estimatedPercent);
      const speed = finiteNumber(session.secondsPerPercent);
      const statLine = document.createElement('p');
      statLine.className = 'session-stat-line';
      const statParts = [
        `已处理 ${hasElapsedSample ? formatDuration(elapsed) : '积累样本'}`,
        `已消耗估算 ${estimate === null ? '积累样本' : formatPercent(estimate)}`,
        `每下降 1% 耗时 ${speed === null || speed <= 0 ? '积累样本' : `${speed.toFixed(3)} 秒`}`,
      ];
      const credits = finiteNumber(session.estimatedCredits);
      if (credits !== null) statParts.push(`估算 credits ${formatCredits(credits)}`);
      statLine.textContent = statParts.join(' · ');
      row.append(statLine);

      const notes = document.createElement('div');
      notes.className = 'session-notes';
      const method = safeText(session.method, estimate === null ? '' : '本机 token 占比假设分摊；可能混入其他设备消耗');
      const confidence = confidenceLabel(session.confidence) || (estimate === null ? '' : '置信度低');
      if (method) notes.append(textElement('span', 'session-note', `方法：${method}`));
      if (confidence) notes.append(textElement('span', 'session-note', confidence));
      if (!isRootSession(session)) notes.append(textElement('span', 'session-note session-note-child', '子会话'));
      if (notes.childNodes.length) row.append(notes);
      list.append(row);
    });
  }

  function updateProgressBar(barId, value) {
    const bar = $(barId);
    const percent = clampPercent(value);
    if (!bar) return;
    if (percent === null) {
      bar.hidden = true;
      bar.style.width = '0%';
      return;
    }
    bar.hidden = false;
    bar.style.width = `${percent}%`;
  }

  function renderAttribution(snapshot) {
    const attribution = isRecord(snapshot) && isRecord(snapshot.attribution) ? snapshot.attribution : {};
    const observed = finiteNumber(attribution.observedPercent);
    const estimated = finiteNumber(attribution.estimatedPercent);
    const unattributed = finiteNumber(attribution.unattributedPercent);
    const attributedTotal = observed === null && estimated === null ? null : (observed || 0) + (estimated || 0);
    setText('attributionTotal', attributedTotal === null ? '—' : formatPercent(attributedTotal), '—');
    setText('observedPercent', observed === null ? '—' : formatPercent(observed), '—');
    setText('estimatedPercent', estimated === null ? '—' : formatPercent(estimated), '—');
    setText('unattributedPercent', unattributed === null ? '—' : formatPercent(unattributed), '—');
    updateProgressBar('observedBar', observed);
    updateProgressBar('estimatedBar', estimated);
    updateProgressBar('unattributedBar', unattributed);
    const sinceDate = parseDate(attribution.since);
    setText('attributionSince', sinceDate ? `从 ${formatDate(sinceDate)}` : safeText(attribution.since, '等待样本'), '等待样本');
    setText('attributionWindow', safeText(attribution.windowLabel, '尚未收到窗口范围。'), '尚未收到窗口范围。');
  }

  function renderAccountWindows(snapshot) {
    const container = $('accountWindows');
    if (!container) return;
    container.replaceChildren();
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : {};
    const windows = Array.isArray(account.windows) ? account.windows.filter((window) => isRecord(window)) : null;
    const error = account.error ? safeError(account.error) : '';
    const errorElement = $('accountError');
    if (errorElement) {
      errorElement.textContent = error;
      errorElement.hidden = !error;
    }
    setText('accountFetchedAt', formatUpdated(account.lastFetchedAt), '等待读取');
    if (!windows) {
      container.append(textElement('div', 'empty-state', '等待账户窗口数据 · 未虚构余量'));
      return;
    }
    if (windows.length === 0) {
      container.append(textElement('div', 'empty-state', '暂无账户窗口数据'));
      return;
    }
    windows.forEach((window, index) => {
      const card = document.createElement('article');
      card.className = 'quota-window';
      const header = document.createElement('div');
      header.className = 'quota-window-header';
      header.append(textElement('h3', 'quota-window-label', window.label || `窗口 ${index + 1}`));
      const windowId = safeText(window.id, 'ID 未提供');
      header.append(textElement('span', 'quota-window-id', windowId));
      card.append(header);

      const values = document.createElement('div');
      values.className = 'quota-values';
      const used = document.createElement('span');
      used.append(textElement('span', 'quota-value-label', '已用'));
      used.append(textElement('strong', '', formatPercent(window.usedPercent)));
      values.append(used);
      const remaining = document.createElement('span');
      remaining.append(textElement('span', 'quota-value-label', '剩余'));
      remaining.append(textElement('strong', '', formatPercent(window.remainingPercent)));
      values.append(remaining);
      card.append(values);

      const remainingPercent = clampPercent(window.remainingPercent);
      const track = document.createElement('div');
      track.className = 'progress-track quota-progress';
      const fill = document.createElement('span');
      fill.className = 'progress-fill fill-remaining';
      if (remainingPercent === null) {
        fill.hidden = true;
      } else {
        fill.style.width = `${remainingPercent}%`;
      }
      track.append(fill);
      card.append(track);

      const reset = document.createElement('div');
      reset.className = 'quota-reset';
      const resetDate = parseDate(window.resetsAt);
      if (resetDate) {
        reset.dataset.resetAt = String(resetDate.getTime());
        reset.append(textElement('span', '', `重置 ${formatDate(resetDate)}`));
        const countdown = textElement('strong', 'quota-countdown', '计算中');
        countdown.dataset.resetOutput = 'true';
        reset.append(countdown);
      } else {
        reset.append(textElement('span', '', '重置时间待定'));
      }
      card.append(reset);
      container.append(card);
    });
  }

  function createSvgElement(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
    return element;
  }

  function renderTrend(snapshot) {
    const chart = $('trendChart');
    if (!chart) return;
    chart.replaceChildren();
    const history = isRecord(snapshot) && Array.isArray(snapshot.history) ? snapshot.history : [];
    const points = history
      .map((point) => ({
        at: parseDate(point && point.at),
        value: clampPercent(point && point.remainingPercent),
      }))
      .filter((point) => point.value !== null);
    if (points.length === 0) {
      chart.append(textElement('div', 'empty-state chart-empty', '尚无趋势样本 · 完成本地读取后会出现'));
      setText('trendLatest', '等待历史样本', '等待历史样本');
      return;
    }
    const width = 680;
    const height = 220;
    const padding = { top: 18, right: 20, bottom: 34, left: 44 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const values = points.map((point) => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const spread = Math.max(1, rawMax - rawMin);
    const min = Math.max(0, rawMin - spread * 0.12);
    const max = Math.min(100, rawMax + spread * 0.12);
    const scaleX = (index) => padding.left + (points.length === 1 ? innerWidth / 2 : index * innerWidth / (points.length - 1));
    const scaleY = (value) => padding.top + ((max - value) / (max - min || 1)) * innerHeight;

    const svg = createSvgElement('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      focusable: 'false',
      'aria-label': '账户剩余额度随时间变化的趋势图',
    });
    const title = createSvgElement('title');
    title.textContent = '账户余量趋势';
    svg.append(title);
    [0, 0.5, 1].forEach((fraction) => {
      const y = padding.top + innerHeight * fraction;
      svg.append(createSvgElement('line', {
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y,
        class: 'chart-grid-line',
      }));
      const label = createSvgElement('text', {
        x: padding.left - 10,
        y: y + 4,
        'text-anchor': 'end',
        class: 'chart-axis-label',
      });
      label.textContent = formatPercent(max - (max - min) * fraction);
      svg.append(label);
    });
    const pathData = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${scaleX(index).toFixed(2)} ${scaleY(point.value).toFixed(2)}`).join(' ');
    svg.append(createSvgElement('path', { d: pathData, class: 'trend-line', fill: 'none' }));
    points.forEach((point, index) => {
      const circle = createSvgElement('circle', {
        cx: scaleX(index),
        cy: scaleY(point.value),
        r: points.length > 30 ? 2.5 : 4,
        class: 'trend-point',
      });
      circle.setAttribute('aria-label', `${formatPercent(point.value)} ${formatDate(point.at, '')}`.trim());
      svg.append(circle);
    });
    const first = points[0];
    const last = points[points.length - 1];
    const firstLabel = createSvgElement('text', { x: padding.left, y: height - 10, class: 'chart-axis-label' });
    firstLabel.textContent = formatDate(first.at, '开始');
    svg.append(firstLabel);
    const lastLabel = createSvgElement('text', { x: width - padding.right, y: height - 10, 'text-anchor': 'end', class: 'chart-axis-label' });
    lastLabel.textContent = formatDate(last.at, '现在');
    svg.append(lastLabel);
    chart.append(svg);
    setText('trendLatest', `最新 ${formatPercent(last.value)} · ${formatDate(last.at, '时间待定')}`, '等待历史样本');
  }

  function renderRecommendation(snapshot) {
    const recommendation = isRecord(snapshot) && isRecord(snapshot.recommendation) ? snapshot.recommendation : {};
    setText('recommendedModel', safeText(recommendation.model, '等待建议'), '等待建议');
    setText('recommendedEffort', safeText(recommendation.reasoningEffort, '—'), '—');
    setText('recommendationReason', safeText(recommendation.reason, '后端返回建议后会显示理由和来源。'), '后端返回建议后会显示理由和来源。');
    const source = safeText(recommendation.source, '等待数据');
    const sourceElement = $('recommendationSource');
    if (sourceElement) {
      sourceElement.replaceChildren(textElement('span', '', `来源：${source}`));
    }
    const error = recommendation.error ? safeError(recommendation.error) : '';
    const errorElement = $('recommendationError');
    if (errorElement) {
      errorElement.textContent = error;
      errorElement.hidden = !error;
    }
    const settings = getSettings(snapshot);
    const objective = $('objectiveSelect');
    const autoSwitch = $('autoSwitchCheckbox');
    const restore = $('restoreDefaultsBtn');
    if (objective && document.activeElement !== objective) objective.value = settings.objective;
    if (autoSwitch && document.activeElement !== autoSwitch) autoSwitch.checked = settings.autoSwitch;
    if (restore) restore.disabled = state.restoreSaving;
  }

  function renderCost(snapshot) {
    const cost = isRecord(snapshot) && isRecord(snapshot.cost) ? snapshot.cost : {};
    const countValue = (value) => finiteNumber(value) === null ? '—' : String(Math.max(0, Math.round(finiteNumber(value))));
    setText('localReads', countValue(cost.localReads), '—');
    setText('remoteReads', countValue(cost.remoteReads), '—');
    const localMs = finiteNumber(cost.lastLocalMs);
    const requests = finiteNumber(cost.requestsPerHour);
    const llmCalls = finiteNumber(cost.llmCalls);
    setText('lastLocalMs', localMs === null ? '—' : `${localMs.toFixed(1)} ms`, '—');
    setText('requestsPerHour', requests === null ? '—' : requests.toFixed(1), '—');
    setText('llmCalls', llmCalls === null ? '—' : String(Math.max(0, Math.round(llmCalls))), '—');
    const settings = getSettings(snapshot);
    const remoteText = finiteNumber(cost.remoteReads) === null ? '远程额度读取按账户额度频率执行' : `已记录 ${countValue(cost.remoteReads)} 次远程额度读取`;
    const llmText = llmCalls === null ? 'LLM 调用等待统计' : `本面板记录 ${Math.max(0, Math.round(llmCalls))} 次 LLM 调用`;
    setText('costExplanation', `每次本地更新通常是 1 次 GET /api/snapshot（约 ${settings.pollSeconds} 秒一次）；${remoteText}（当前 ${settings.quotaPollSeconds} 秒间隔）。${llmText}。归因可能使用本机 token 占比假设分摊；可能混入其他设备消耗，不能当作官方拆账。`, '等待成本统计');
  }

  function renderReset(snapshot) {
    const reset = isRecord(snapshot) && isRecord(snapshot.reset) ? snapshot.reset : {};
    const resetSeconds = finiteNumber(reset.secondsUntil);
    setText('officialResetCountdown', resetSeconds === null ? '等待数据' : formatShortDuration(resetSeconds), '等待数据');
    setText('officialResetAt', formatDate(reset.scheduledAt, '官方时间待定'), '官方时间待定');
    const exhaustionDate = parseDate(reset.exhaustionAt);
    state.exhaustionAt = reset.exhaustionAt;
    setText('exhaustionEstimate', exhaustionDate ? formatShortDuration((exhaustionDate.getTime() - Date.now()) / 1000, '已到期') : '等待速率样本', '等待速率样本');
    setText('exhaustionAt', exhaustionDate ? formatDate(exhaustionDate) : '当前速率尚无可用估计', '当前速率尚无可用估计');
    const unexpected = safeText(reset.unexpected, 'unknown').toLowerCase();
    setText('unexpectedReset', !unexpected || unexpected === 'unknown' ? '未知' : safeText(reset.unexpected), '未知');
  }

  function renderDiagnostics(snapshot) {
    const list = $('diagnosticsList');
    if (!list) return;
    list.replaceChildren();
    const diagnostics = isRecord(snapshot) && Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [];
    setText('snapshotVersion', `版本 ${safeText(isRecord(snapshot) ? snapshot.version : null, '—')}`, '版本 —');
    if (diagnostics.length === 0) {
      list.append(textElement('div', 'empty-state diagnostics-empty', '暂无诊断信息'));
      return;
    }
    diagnostics.forEach((diagnostic) => {
      const item = document.createElement('div');
      item.className = 'diagnostic-item';
      if (isRecord(diagnostic)) {
        const level = safeText(diagnostic.level, 'info').toLowerCase();
        item.classList.add(level === 'error' ? 'diagnostic-error' : level === 'warn' || level === 'warning' ? 'diagnostic-warning' : 'diagnostic-info');
        item.append(textElement('span', 'diagnostic-level', level));
        item.append(textElement('span', 'diagnostic-message', diagnostic.message || diagnostic.detail || '未提供详情'));
      } else {
        item.classList.add('diagnostic-info');
        item.append(textElement('span', 'diagnostic-message', diagnostic));
      }
      list.append(item);
    });
  }

  function renderSettings(snapshot) {
    const settings = getSettings(snapshot);
    const poll = $('pollSecondsInput');
    const quotaPoll = $('quotaPollSecondsInput');
    const paused = $('pausedCheckbox');
    if (poll && document.activeElement !== poll) poll.value = String(settings.pollSeconds);
    if (quotaPoll && document.activeElement !== quotaPoll) quotaPoll.value = String(settings.quotaPollSeconds);
    if (paused && document.activeElement !== paused) paused.checked = settings.paused;
    const reminder = $('restoreDisclaimerBtn');
    if (reminder) reminder.disabled = state.reminderSaving;
    if (!state.settingsSaving) setText('settingsSaveStatus', '设置已同步', '设置已同步');
  }

  function renderCountdowns() {
    if (state.resetBaseSeconds !== null && state.resetBaseAt !== null) {
      const elapsed = (Date.now() - state.resetBaseAt) / 1000;
      const remaining = state.resetBaseSeconds - elapsed;
      setText('nextResetValue', formatShortDuration(remaining), '—');
      setText('officialResetCountdown', formatShortDuration(remaining), '等待数据');
    }
    const exhaustion = parseDate(state.exhaustionAt);
    if (exhaustion) {
      setText('exhaustionEstimate', formatShortDuration((exhaustion.getTime() - Date.now()) / 1000, '已到期'), '等待速率样本');
    }
    document.querySelectorAll('[data-reset-at]').forEach((element) => {
      const timestamp = finiteNumber(element.dataset.resetAt);
      const output = element.querySelector('[data-reset-output]');
      if (timestamp === null || !output) return;
      const seconds = (timestamp - Date.now()) / 1000;
      output.textContent = seconds < 0 ? '已到期' : `约 ${formatShortDuration(seconds)}`;
    });
  }

  function render(snapshot) {
    const safeSnapshot = isRecord(snapshot) ? snapshot : {};
    renderConnection(snapshot);
    renderGlobalError(safeSnapshot);
    renderOverview(safeSnapshot);
    renderSessionList(safeSnapshot);
    renderAccountWindows(safeSnapshot);
    renderAttribution(safeSnapshot);
    renderTrend(safeSnapshot);
    renderRecommendation(safeSnapshot);
    renderCost(safeSnapshot);
    renderReset(safeSnapshot);
    renderDiagnostics(safeSnapshot);
    renderSettings(safeSnapshot);
    setText('footerUpdatedAt', formatUpdated(state.lastUpdatedAt || safeSnapshot.now), '尚未同步');
    renderCountdowns();
  }

  async function responseError(response) {
    let detail = '';
    try {
      const body = await response.text();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          detail = safeError(parsed, '');
        } catch (_error) {
          detail = body.trim().slice(0, 180);
        }
      }
    } catch (_error) {
      detail = '';
    }
    return `HTTP ${response.status}${detail ? ` · ${detail}` : ''}`;
  }

  function schedulePoll() {
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    const settings = getSettings(state.snapshot || {});
    state.pollTimer = window.setTimeout(() => {
      state.pollTimer = null;
      fetchSnapshot();
    }, settings.pollSeconds * 1000);
  }

  async function fetchSnapshot() {
    if (state.fetching) return;
    state.fetching = true;
    render(state.snapshot || {});
    try {
      const response = await window.fetch(API_SNAPSHOT, {
        method: 'GET',
        headers: requestHeaders(),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json();
      if (!isRecord(payload)) throw new Error('快照格式无效');
      state.snapshot = payload;
      state.error = null;
      state.lastUpdatedAt = Date.now();
    } catch (error) {
      state.error = safeError(error, '读取快照失败');
    } finally {
      state.fetching = false;
      render(state.snapshot || {});
      schedulePoll();
    }
  }

  function mergeSettingsIntoSnapshot(patch) {
    const base = isRecord(state.snapshot) ? state.snapshot : {};
    const current = isRecord(base.settings) ? base.settings : {};
    state.snapshot = { ...base, settings: { ...current, ...patch } };
  }

  async function postSettings(patch, { surfaceError = true } = {}) {
    const previousError = state.error;
    state.lastSettingsError = null;
    state.settingsSaving = true;
    setText('settingsSaveStatus', '保存中…', '保存中…');
    try {
      const response = await window.fetch(API_SETTINGS, {
        method: 'POST',
        headers: requestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(patch),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response));
      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (isRecord(payload) && isRecord(payload.settings)) {
        if (Object.hasOwn(payload, 'version') || Object.hasOwn(payload, 'sessions') || Object.hasOwn(payload, 'account')) {
          state.snapshot = payload;
        } else {
          mergeSettingsIntoSnapshot(payload.settings);
        }
      } else {
        mergeSettingsIntoSnapshot(patch);
      }
      state.error = null;
      setText('settingsSaveStatus', '设置已保存', '设置已保存');
      render(state.snapshot || {});
      schedulePoll();
      return true;
    } catch (error) {
      const message = safeError(error, '设置保存失败');
      state.lastSettingsError = message;
      state.error = surfaceError ? message : previousError;
      if (surfaceError) {
        setText('settingsSaveStatus', '保存失败', '保存失败');
        render(state.snapshot || {});
      }
      return false;
    } finally {
      state.settingsSaving = false;
    }
  }

  function queueSettingsPatch(patch) {
    state.settingsQueue = state.settingsQueue
      .catch(() => undefined)
      .then(() => postSettings(patch));
    return state.settingsQueue;
  }

  async function restoreDefaults() {
    if (state.restoreSaving) return;
    state.restoreSaving = true;
    const button = $('restoreDefaultsBtn');
    const status = $('restoreDefaultsStatus');
    const errorElement = $('restoreDefaultsError');
    if (button) button.disabled = true;
    if (status) status.textContent = '恢复中…';
    if (errorElement) {
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
    try {
      const response = await window.fetch('/api/restore-defaults', {
        method: 'POST',
        headers: requestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response));
      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (isRecord(payload) && Object.hasOwn(payload, 'settings')) {
        if (Object.hasOwn(payload, 'version') || Object.hasOwn(payload, 'sessions') || Object.hasOwn(payload, 'account')) {
          state.snapshot = payload;
        } else {
          mergeSettingsIntoSnapshot(payload.settings);
        }
      }
      if (status) status.textContent = '已恢复接管前默认模型';
      render(state.snapshot || {});
      schedulePoll();
    } catch (error) {
      const message = safeError(error, '恢复失败');
      if (status) status.textContent = '未恢复';
      if (errorElement) {
        errorElement.textContent = `恢复失败：${message}`;
        errorElement.hidden = false;
      }
    } finally {
      state.restoreSaving = false;
      if (button) button.disabled = false;
    }
  }

  function readIntegerInput(id, min, max, fallback) {
    const input = $(id);
    const value = input ? finiteNumber(input.value) : null;
    const bounded = value === null ? fallback : Math.min(max, Math.max(min, Math.round(value)));
    if (input) input.value = String(bounded);
    return bounded;
  }

  function bindControls() {
    const refresh = $('refreshBtn');
    const retry = $('retryBtn');
    if (refresh) refresh.addEventListener('click', () => fetchSnapshot());
    if (retry) retry.addEventListener('click', () => fetchSnapshot());

    const poll = $('pollSecondsInput');
    if (poll) poll.addEventListener('change', () => queueSettingsPatch({ pollSeconds: readIntegerInput('pollSecondsInput', 2, 300, 5) }));
    const quotaPoll = $('quotaPollSecondsInput');
    if (quotaPoll) quotaPoll.addEventListener('change', () => queueSettingsPatch({ quotaPollSeconds: readIntegerInput('quotaPollSecondsInput', 5, 3600, 30) }));
    const paused = $('pausedCheckbox');
    if (paused) paused.addEventListener('change', () => queueSettingsPatch({ paused: paused.checked }));
    const objective = $('objectiveSelect');
    if (objective) objective.addEventListener('change', () => {
      const value = OBJECTIVES.has(objective.value) ? objective.value : 'balanced';
      objective.value = value;
      queueSettingsPatch({ objective: value });
    });
    const autoSwitch = $('autoSwitchCheckbox');
    if (autoSwitch) autoSwitch.addEventListener('change', () => queueSettingsPatch({ autoSwitch: autoSwitch.checked }));
    const restore = $('restoreDefaultsBtn');
    if (restore) restore.addEventListener('click', () => restoreDefaults());
  }

  function localStorageFlagIsSet() {
    try {
      return window.localStorage.getItem(DISCLAIMER_KEY) === '1';
    } catch (_error) {
      return false;
    }
  }

  function hideDisclaimerModal() {
    const modal = $('disclaimerModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    if (state.lastFocusBeforeModal && typeof state.lastFocusBeforeModal.focus === 'function') {
      state.lastFocusBeforeModal.focus();
    }
  }

  function openDisclaimerIfNeeded() {
    const settings = getSettings(state.snapshot || {});
    if (settings.hideDisclaimer || localStorageFlagIsSet()) return;
    const modal = $('disclaimerModal');
    const confirm = $('confirmDisclaimerBtn');
    if (!modal || !confirm) return;
    const checkbox = $('doNotRemindCheckbox');
    const errorElement = $('disclaimerError');
    if (checkbox) checkbox.checked = false;
    if (errorElement) {
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
    state.lastFocusBeforeModal = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    confirm.focus();
  }

  async function confirmDisclaimer() {
    const checkbox = $('doNotRemindCheckbox');
    const confirm = $('confirmDisclaimerBtn');
    const errorElement = $('disclaimerError');
    if (!checkbox || !confirm || state.disclaimerSaving) return;
    if (!checkbox.checked) {
      hideDisclaimerModal();
      return;
    }
    state.disclaimerSaving = true;
    confirm.disabled = true;
    if (errorElement) {
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
    const saved = await postSettings({ hideDisclaimer: true }, { surfaceError: false });
    state.disclaimerSaving = false;
    confirm.disabled = false;
    if (!saved) {
      if (errorElement) {
        errorElement.textContent = `保存失败：${safeError(state.lastSettingsError || state.error, '服务器未接受提醒设置')}。请取消勾选“不再提醒”后确认继续。`;
        errorElement.hidden = false;
      }
      return;
    }
    try {
      window.localStorage.setItem(DISCLAIMER_KEY, '1');
    } catch (_error) {
      // The persisted server setting still suppresses the reminder if localStorage is unavailable.
    }
    hideDisclaimerModal();
  }

  async function restoreDisclaimer() {
    if (state.reminderSaving) return;
    state.reminderSaving = true;
    const button = $('restoreDisclaimerBtn');
    const status = $('restoreDisclaimerStatus');
    const errorElement = $('restoreDisclaimerError');
    if (button) button.disabled = true;
    if (status) status.textContent = '保存中…';
    if (errorElement) {
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
    const saved = await postSettings({ hideDisclaimer: false }, { surfaceError: false });
    state.reminderSaving = false;
    if (button) button.disabled = false;
    if (!saved) {
      if (status) status.textContent = '未恢复';
      if (errorElement) {
        errorElement.textContent = `恢复失败：${safeError(state.lastSettingsError || state.error, '服务器未接受提醒设置')}`;
        errorElement.hidden = false;
      }
      return;
    }
    try {
      window.localStorage.removeItem(DISCLAIMER_KEY);
    } catch (_error) {
      // The server setting is the source of truth when localStorage is unavailable.
    }
    if (status) status.textContent = '已恢复，下次打开时提醒';
    openDisclaimerIfNeeded();
  }

  function bindDisclaimer() {
    const confirm = $('confirmDisclaimerBtn');
    if (confirm) confirm.addEventListener('click', () => confirmDisclaimer());
    const restore = $('restoreDisclaimerBtn');
    if (restore) restore.addEventListener('click', () => restoreDisclaimer());
    document.addEventListener('keydown', (event) => {
      const modal = $('disclaimerModal');
      if (!modal || modal.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        confirm && confirm.focus();
      }
      if (event.key === 'Tab') {
        const focusable = [confirm, $('doNotRemindCheckbox')].filter((element) => element && !element.disabled);
        if (!focusable.length) return;
        const current = document.activeElement;
        const index = focusable.indexOf(current);
        const next = event.shiftKey
          ? focusable[(index <= 0 ? focusable.length : index) - 1]
          : focusable[(index + 1) % focusable.length];
        event.preventDefault();
        next.focus();
      }
    });
  }

  function init() {
    const query = new URLSearchParams(window.location.search);
    state.compact = query.get('compact') === '1' || query.get('compact') === 'true';
    if (state.compact) {
      document.body.classList.add('compact');
      setHidden('compactStatus', false);
    }
    bindControls();
    bindDisclaimer();
    render({});
    window.setInterval(renderCountdowns, 1000);
    fetchSnapshot().finally(() => openDisclaimerIfNeeded());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
