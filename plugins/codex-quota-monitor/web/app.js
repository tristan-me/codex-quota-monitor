(() => {
  'use strict';

  const API_SNAPSHOT = '/api/snapshot';
  const API_SETTINGS = '/api/settings';
  const DISCLAIMER_KEY = 'codexQuotaMonitor.disclaimerDismissed';
  const OBJECTIVES = new Set(['economy', 'balanced', 'quality']);
  const EFFORT_ORDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low'];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = {
    snapshot: null,
    error: null,
    offline: false,
    mode: 'unknown',
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
    sessionQuery: '',
    sessionPage: 0,
    sessionPageSize: 5,
    expandedSessionIds: new Set(),
    sessionAutoCollapsedIds: new Set(),
    modelPage: 0,
    modelSelectedId: null,
    resetEvidenceExpanded: new Set(),
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
    return parsed === null ? '—' : `${parsed.toFixed(2)}%`;
  }

  function formatTaskPercent(value) {
    const parsed = finiteNumber(value);
    if (parsed === null) return '—';
    if (parsed > 0 && parsed < 0.1) {
      const exponent = Math.floor(Math.log10(parsed));
      const decimalPlaces = 2 - exponent;
      if (decimalPlaces <= 10) return `${parsed.toFixed(decimalPlaces)}%`;
      return `${parsed.toExponential(2).replace('e+', 'e')}%`;
    }
    return formatPercent(parsed);
  }

  function formatCredits(value) {
    const parsed = finiteNumber(value);
    return parsed === null ? '—' : parsed.toFixed(2);
  }

  function formatDuration(value, empty = '—') {
    const parsed = finiteNumber(value);
    if (parsed === null || parsed < 0) return empty;
    const totalSeconds = Math.floor(parsed);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (totalSeconds < 60) return `${seconds}秒`;
    return hours > 0 ? `${hours}时${minutes}分${seconds}秒` : `${minutes}分${seconds}秒`;
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

  function formatBeijingDateTime(value, fallback = '时间待定') {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return fallback;
    try {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date).reduce((map, part) => {
        map[part.type] = part.value;
        return map;
      }, {});
      return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}时${parts.minute}分${parts.second}秒（北京时间）`;
    } catch (_error) {
      return fallback;
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

  // Keep the endpoint credential stable while navigating within this page.
  const accessToken = getTokenFromHash();

  function requestHeaders(extra = {}) {
    const headers = new Headers(extra);
    headers.set('Accept', 'application/json');
    if (accessToken) headers.set('X-Quota-Token', accessToken);
    return headers;
  }

  function getSettings(snapshot) {
    const source = isRecord(snapshot) && isRecord(snapshot.settings) ? snapshot.settings : {};
    const objective = OBJECTIVES.has(source.objective) ? source.objective : 'balanced';
    return {
      pollSeconds: boundedNumber(source.pollSeconds, 5, 2, 300),
      quotaPollSeconds: boundedNumber(source.quotaPollSeconds, 30, 5, 3600),
      retentionHours: boundedNumber(source.retentionHours, 24, 1, 168),
      paused: source.paused === true,
      autoSwitch: source.autoSwitch === true,
      hideDisclaimer: source.hideDisclaimer === true,
      objective,
    };
  }

  function modeOf(snapshot) {
    if (state.offline) return 'offline';
    const values = [];
    if (isRecord(snapshot)) {
      values.push(snapshot.mode);
      if (isRecord(snapshot.dataSource)) {
        values.push(snapshot.dataSource.mode, snapshot.dataSource.kind, snapshot.dataSource.type, snapshot.dataSource.source, snapshot.dataSource.label);
      } else {
        values.push(snapshot.dataSource);
      }
      if (isRecord(snapshot.account) && isRecord(snapshot.account.plan)) values.push(snapshot.account.plan.source);
    }
    const joined = values
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (/demo|演示|synthetic|合成/.test(joined)) return 'demo';
    if (/live|实时|official|current-local-codex-account|account\/ratelimits\/read/.test(joined)) return 'live';
    return 'unknown';
  }

  function modeCopy(mode) {
    if (mode === 'live') {
      return {
        label: '实时账户数据',
        detail: '账户窗口来自官方额度接口；会话数字仍是监控期间估算。',
      };
    }
    if (mode === 'demo') {
      return {
        label: '演示数据，不是你的账户或任务',
        detail: '合成会话和账户值仅用于预览；模型自动操作已禁用。',
      };
    }
    if (mode === 'offline') {
      return {
        label: '服务已关闭 / 链接已过期',
        detail: '请重新运行 Open-Monitor.command，或从新任务打开监控器。',
      };
    }
    return {
      label: '数据源未声明',
      detail: '等待服务声明 live 或 demo；当前数字不应视为账户数据。',
    };
  }

  function accountSummaryFrom(snapshot) {
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : {};
    const summary = isRecord(account.summary) ? account.summary : {};
    const windows = Array.isArray(account.windows) ? account.windows.filter((entry) => isRecord(entry)) : [];
    const fallback = windows[0] || {};
    const choose = (key) => Object.prototype.hasOwnProperty.call(summary, key) ? summary[key] : fallback[key];
    return {
      usedPercent: choose('usedPercent'),
      remainingPercent: choose('remainingPercent'),
      windowLabel: choose('windowLabel') || choose('label'),
      windowMinutes: choose('windowMinutes'),
      resetsAt: choose('resetsAt'),
      observedAt: choose('observedAt') || account.lastFetchedAt,
    };
  }

  function freshness(value, stale = false) {
    if (state.mode === 'demo') return {label:'演示样本',className:'freshness-demo'};
    const date = parseDate(value);
    if (stale) {
      return { label: date ? `旧样本 · ${formatBeijingDateTime(date)}` : '旧样本 · 服务报告已过期', className: 'freshness-stale' };
    }
    if (!date) return { label: '样本时间待定', className: 'freshness-unknown' };
    const age = Math.max(0, Date.now() - date.getTime());
    if (age < 15_000) return { label: '刚刚采样', className: 'freshness-fresh' };
    if (age < 120_000) return { label: `${Math.floor(age / 1000)} 秒前采样`, className: 'freshness-fresh' };
    if (age < 3_600_000) return { label: `${Math.floor(age / 60_000)} 分钟前采样`, className: 'freshness-aging' };
    return { label: `旧样本 · ${formatBeijingDateTime(date)}`, className: 'freshness-stale' };
  }

  function sessionsFrom(snapshot) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) return null;
    return snapshot.sessions.filter((session) => isRecord(session));
  }

  function isActiveStatus(status) {
    const normalized = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['running', 'active', 'thinking', 'in_progress', 'inprogress', 'processing', 'working', 'started', 'pending', 'queued'].includes(normalized);
  }

  function isCurrentlyRunning(status) {
    const normalized = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['running', 'active', 'thinking', 'in_progress', 'inprogress', 'processing', 'working', 'started'].includes(normalized);
  }

  function isFinishedStatus(status) {
    const normalized = String(status || '').toLowerCase().replace(/[\s-]+/g, '_');
    return ['completed', 'complete', 'succeeded', 'success', 'failed', 'failure', 'interrupted', 'aborted', 'cancelled', 'canceled', 'error', 'done', 'idle'].includes(normalized);
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
    return `置信度 ${percentage.toFixed(2)}%`;
  }

  function summaryStatus(snapshot) {
    const sessions = sessionsFrom(snapshot);
    if (!sessions) return '等待会话样本';
    const active = sessions.filter((session) => isRootSession(session) && isActiveStatus(session.status)).length;
    if (active === 0) return '当前没有活跃根会话';
    return `${active} 个活跃根会话正在采样`;
  }

  function renderMode(snapshot) {
    const mode = modeOf(snapshot);
    state.mode = mode;
    const copy = modeCopy(mode);
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : {};
    if (mode === 'live' && account.stale === true) {
      copy.detail = '账户官方样本已过期；以下数字保留作参考，不代表实时额度。';
    }
    const banner = $('modeBanner');
    if (banner) {
      banner.classList.remove('mode-live', 'mode-demo', 'mode-offline', 'mode-unknown', 'is-stale');
      banner.classList.add(`mode-${mode}`);
      if (mode === 'live' && account.stale === true) banner.classList.add('is-stale');
    }
    const titles = {
      live: 'Codex 额度监控器',
      demo: '演示数据 · Codex 额度监控器',
      offline: '服务离线 · Codex 额度监控器',
      unknown: '数据源未声明 · Codex 额度监控器',
    };
    document.title = titles[mode] || titles.unknown;
    setText('modeBannerLabel', copy.label, '数据源未声明');
    setText('modeBannerDetail', copy.detail, '等待服务声明 live 或 demo；请先确认数据来源。');
    const watermark = $('demoWatermark');
    if (watermark) {
      watermark.hidden = mode !== 'demo';
      watermark.setAttribute('aria-hidden', mode === 'demo' ? 'false' : 'true');
    }
    const allowModelOperations = mode === 'live' && !state.offline;
    const objective = $('objectiveSelect');
    const autoSwitch = $('autoSwitchCheckbox');
    const restoreDefaults = $('restoreDefaultsBtn');
    if (objective) objective.disabled = !allowModelOperations;
    if (autoSwitch) autoSwitch.disabled = !allowModelOperations;
    if (restoreDefaults) restoreDefaults.disabled = !allowModelOperations || state.restoreSaving;
    setHidden('demoSettingsNote', mode !== 'demo');
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
    } else if (state.offline) {
      pill.classList.add('is-error');
      text.textContent = '已离线';
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
    if (refresh) {
      refresh.disabled = state.fetching || state.offline;
      refresh.hidden = state.offline;
    }
    const settings = getSettings(snapshot);
    const updated = formatUpdated(state.lastUpdatedAt || (isRecord(snapshot) ? snapshot.now : null));
    const accountError = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account.error : null;
    const status = state.offline ? '服务已关闭或链接已过期' : state.error ? '连接异常' : accountError ? '账户额度读取异常' : state.fetching ? '读取本地快照' : '已连接';
    const statusText = state.offline
      ? `${status} · 请重新运行 Open-Monitor.command，或从新任务打开监控器`
      : `${status} · 本地每 ${settings.pollSeconds} 秒刷新 · ${updated}${settings.paused ? ' · 远程额度暂停' : ''}`;
    setText('globalStatus', statusText, '等待连接');
    setText('compactStatusText', statusText, '等待连接');
  }

  function renderGlobalError(snapshot) {
    const element = $('globalError');
    const message = $('globalErrorText');
    const retry = $('retryBtn');
    if (!element || !message) return;
    if (state.offline) {
      message.textContent = '服务已关闭或链接已过期。请重新运行 Open-Monitor.command，或从新任务打开“Codex 额度监控器”；不要反复刷新此旧链接。';
      element.hidden = false;
      if (retry) retry.hidden = true;
      return;
    }
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : null;
    const visibleError = state.error || (account && account.error ? safeError(account.error, '') : '');
    if (!visibleError) {
      element.hidden = true;
      if (retry) retry.hidden = false;
      return;
    }
    message.textContent = state.error
      ? `无法读取最新本地快照：${safeError(state.error)}`
      : `账户额度暂不可用：${safeError(visibleError)}`;
    element.hidden = false;
    if (retry) retry.hidden = false;
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

    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : {};
    const summary = accountSummaryFrom(snapshot);
    const remaining = finiteNumber(summary.remainingPercent);
    const used = finiteNumber(summary.usedPercent);
    const mode = state.mode;
    const suffix = mode === 'live' ? '（官方）' : mode === 'demo' ? '（演示）' : '（待确认）';
    const sample = freshness(summary.observedAt, account.stale === true);
    setText('accountRemainingLabel', `账户剩余${suffix}`, '账户剩余（待确认）');
    setText('accountUsedLabel', `账户已用${suffix}`, '账户已用（待确认）');
    setText('accountRemainingValue', remaining === null ? '—' : formatPercent(remaining), '—');
    setText('accountUsedValue', used === null ? '—' : formatPercent(used), '—');
    setText('accountRemainingDetail', remaining === null ? '等待官方额度窗口' : `${safeText(summary.windowLabel, '官方额度窗口')} · ${sample.label}`, '等待官方额度窗口');
    setText('accountUsedDetail', used === null ? '等待官方额度窗口' : `直接来自额度接口 · ${sample.label}`, '直接来自额度接口');
    setText('summaryUsedPercent', used === null ? '—' : formatPercent(used), '—');
    setText('summaryRemainingPercent', remaining === null ? '—' : formatPercent(remaining), '—');
    setText('summaryWindowLabel', safeText(summary.windowLabel, '—'), '—');
    const sampleElement = $('accountFreshness');
    if (sampleElement) {
      sampleElement.textContent = sample.label;
      sampleElement.classList.remove('freshness-fresh', 'freshness-aging', 'freshness-stale', 'freshness-unknown');
      sampleElement.classList.add(sample.className);
      sampleElement.title = summary.observedAt ? formatBeijingDateTime(summary.observedAt) : '样本时间待定';
    }

    const plan = isRecord(account.plan) ? account.plan : {};
    const planType = safeText(plan.type, '读取中');
    const normalizedPlan = planType.toLowerCase() === 'pro' ? 'Pro' : planType;
    const planPrefix = mode === 'live' ? '官方' : mode === 'demo' ? '演示' : '待确认';
    setText('planBadge', `${planPrefix} ${normalizedPlan}`, `${planPrefix} 读取中`);
    const planSource = safeText(plan.source, 'account/rateLimits/read');
    const planDetail = safeText(plan.detail, '额度接口未提供套餐说明。');
    setText('planDetail', `来源：${planSource} · ${planDetail}`, '来源：等待 account/rateLimits/read');
    const multiplier = finiteNumber(plan.multiplier);
    setText('planMultiplierNote', multiplier === null
      ? '接口未区分 5x/20x；不用于计算官方百分比或重置，也不自动假设 Plus。'
      : `接口报告倍率 ${multiplier.toFixed(2)}x；官方百分比和重置仍直接取额度接口。`, '接口未提供倍率信息。');
  }

  function sessionQueryTokens(query) {
    return String(query || '').split(/[\s,，]+/).map((token) => token.trim()).filter(Boolean);
  }

  function sessionMatches(session, tokens) {
    if (!tokens.length) return false;
    const title = safeText(session.title, '').toLocaleLowerCase();
    const id = safeText(session.id, '');
    return tokens.some((token) => title.includes(token.toLocaleLowerCase()) || id === token);
  }

  function sessionEstimatedPercent(session) {
    const status = safeText(session.estimateStatus, '').toLowerCase();
    if (status === 'unavailable' || status === 'projected') return null;
    return finiteNumber(session.estimatedPercent);
  }

  function sessionMetric(session, currentKey, fallbackKey, estimate = false) {
    if (Object.prototype.hasOwnProperty.call(session, currentKey)) return finiteNumber(session[currentKey]);
    return estimate ? sessionEstimatedPercent(session) : finiteNumber(session[fallbackKey]);
  }

  function sessionTotals(session) {
    return {
      totalElapsedSeconds: sessionMetric(session, 'totalElapsedSeconds', 'observationSeconds'),
      totalEstimatedPercent: sessionMetric(session, 'totalEstimatedPercent', 'estimatedPercent', true),
      averageSecondsPerPercent: sessionMetric(session, 'averageSecondsPerPercent', 'averageSecondsPerPercent'),
      latestTurnElapsedSeconds: sessionMetric(session, 'latestTurnElapsedSeconds', Object.prototype.hasOwnProperty.call(session, 'ownLatestTurnElapsedSeconds') ? 'ownLatestTurnElapsedSeconds' : 'elapsedSeconds'),
      latestTurnEstimatedPercent: Object.prototype.hasOwnProperty.call(session, 'latestTurnEstimatedPercent')
        ? finiteNumber(session.latestTurnEstimatedPercent)
        : finiteNumber(session.ownLatestTurnEstimatedPercent),
      secondsPerPercent: sessionMetric(session, 'latestTurnSecondsPerPercent', Object.prototype.hasOwnProperty.call(session, 'ownLatestTurnSecondsPerPercent') ? 'ownLatestTurnSecondsPerPercent' : 'secondsPerPercent'),
    };
  }

  function latestTurnScopeText(session) {
    const count = finiteNumber(session.latestTurnChildCount);
    if (count === null) return '最近一次的子任务归属待确认。';
    if (count <= 0) return '最近一次仅含本任务本轮。';
    return `最近一次含本轮启动的 ${Math.round(count)} 个子任务。`;
  }

  function sessionFilterEntries(sessions, tokens) {
    return sessions.map((root) => {
      const children = Array.isArray(root.children) ? root.children.filter((child) => isRecord(child)) : [];
      const rootMatches = sessionMatches(root, tokens);
      const matchingChildren = tokens.length ? children.filter((child) => sessionMatches(child, tokens)) : [];
      if (tokens.length && !rootMatches && matchingChildren.length === 0) return null;
      return { root, children, rootMatches, matchingChildren };
    }).filter(Boolean);
  }

  function renderSessionPagination(filteredCount, totalCount) {
    const pageSize = state.sessionPageSize;
    const pages = Math.max(1, Math.ceil(filteredCount / pageSize));
    state.sessionPage = Math.min(Math.max(0, state.sessionPage), pages - 1);
    const prev = $('sessionPrev');
    const next = $('sessionNext');
    const expand = $('sessionExpandMore');
    const reset = $('sessionResetPageSize');
    const pageInfo = $('sessionPageInfo');
    if (prev) prev.disabled = state.sessionPage <= 0 || filteredCount === 0;
    if (next) next.disabled = state.sessionPage >= pages - 1 || filteredCount === 0;
    if (expand) {
      expand.disabled = pageSize >= filteredCount || filteredCount === 0;
      expand.hidden = filteredCount === 0;
    }
    if (reset) reset.hidden = pageSize <= 5;
    if (pageInfo) pageInfo.textContent = filteredCount === 0 ? '无匹配会话' : `第 ${state.sessionPage + 1} / ${pages} 页 · 每页 ${pageSize}`;
    setText('sessionFilterSummary', filteredCount === totalCount ? `共 ${totalCount} 个根会话` : `匹配 ${filteredCount} / ${totalCount} 个根会话`, '显示全部会话');
  }

  function renderSessionList(snapshot) {
    const list = $('sessionList');
    if (!list) return;
    list.replaceChildren();
    const sessions = sessionsFrom(snapshot);
    const searchInput = $('sessionSearch');
    if (searchInput && searchInput.value !== state.sessionQuery && document.activeElement !== searchInput) searchInput.value = state.sessionQuery;
    setText('sessionSummaryText', summaryStatus(snapshot), '等待会话样本');
    const settings = getSettings(snapshot);
    setText('sessionRefreshHint', `最近 ${settings.retentionHours} 小时 · 每 ${settings.pollSeconds} 秒更新`, '最近 24 小时 · 每 5 秒更新');
    if (!sessions) {
      list.append(textElement('div', 'empty-state', '等待本地会话快照'));
      renderSessionPagination(0, 0);
      return;
    }
    if (sessions.length === 0) {
      list.append(textElement('div', 'empty-state', '当前没有可显示会话'));
      renderSessionPagination(0, 0);
      return;
    }
    const tokens = sessionQueryTokens(state.sessionQuery);
    const entries = sessionFilterEntries(sessions, tokens);
    renderSessionPagination(entries.length, sessions.length);
    if (entries.length === 0) {
      list.append(textElement('div', 'empty-state', '没有匹配的会话 · 可清除搜索条件'));
      return;
    }
    const start = state.sessionPage * state.sessionPageSize;
    entries.slice(start, start + state.sessionPageSize).forEach((entry, index) => {
      const session = entry.root;
      const row = document.createElement('article');
      row.className = 'session-row';
      row.setAttribute('role', 'listitem');

      const header = document.createElement('div');
      header.className = 'session-row-header';
      const titleBlock = document.createElement('div');
      titleBlock.className = 'session-title-block';
      const titleValue = safeText(session.title, `未命名会话 ${start + index + 1}`);
      const title = textElement('h3', 'session-title', titleValue);
      title.title = titleValue;
      titleBlock.append(title);
      const identity = safeText(session.id, '—');
      const idElement = textElement('span', 'session-id', identity);
      idElement.title = identity;
      titleBlock.append(idElement);
      header.append(titleBlock);
      const status = textElement('span', `status-chip ${statusClass(session.status)}`, statusLabel(session.status));
      header.append(status);
      row.append(header);

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      const model = safeText(session.model, '—');
      const effort = safeText(session.reasoningEffort, '—');
      const modelElement = textElement('span', 'meta-item meta-title', model);
      modelElement.title = model;
      meta.append(modelElement);
      meta.append(textElement('span', 'meta-separator', '·'));
      meta.append(textElement('span', 'meta-item', effort));
      const childCount = finiteNumber(session.childCount);
      if (childCount !== null) {
        meta.append(textElement('span', 'meta-separator', '·'));
        meta.append(textElement('span', 'meta-item', `子会话 ${Math.max(0, Math.round(childCount))} 个`));
      }
      row.append(meta);

      const children = Array.isArray(session.children) ? session.children.filter((child) => isRecord(child)) : [];
      const metrics = sessionTotals(session);
      const statLine = document.createElement('div');
      statLine.className = 'session-stat-line';
      const totalLine = `近${settings.retentionHours}小时任务耗时${formatDuration(metrics.totalElapsedSeconds)}，任务消耗额度${formatTaskPercent(metrics.totalEstimatedPercent)}，平均每 1% 额度能撑 ${formatDuration(metrics.averageSecondsPerPercent)}；`;
      const latestLine = `最近一次会话耗时${formatDuration(metrics.latestTurnElapsedSeconds)}，最近一次会话消耗额度${formatTaskPercent(metrics.latestTurnEstimatedPercent)}，预计接下来每 1% 额度能撑 ${formatDuration(metrics.secondsPerPercent)}`;
      statLine.append(textElement('span', 'session-stat-line-block', totalLine));
      statLine.append(textElement('span', 'session-stat-line-block', latestLine));
      row.append(statLine);

      if (session.estimateIncludesRecovery === true || session.ownEstimateIncludesRecovery === true) {
        row.append(textElement('p', 'session-scope-note', session.latestTurnEstimateIncludesRecovery === true
          ? '最近一轮的部分额度由已记录的 token 用量校准补估。'
          : '任务总额包含历史单轮的 token 用量校准补估。'));
      }

      if (children.length > 0) {
        const ownQuota = finiteNumber(session.ownEstimatedPercent);
        const childQuotas = children.map((child) => {
          const own = finiteNumber(child.ownEstimatedPercent);
          return own !== null ? own : sessionMetric(child, 'totalEstimatedPercent', 'estimatedPercent');
        });
        const knownChildQuotas = childQuotas.filter(value => value !== null);
        const childQuota = knownChildQuotas.reduce((sum, value) => sum + value, 0);
        const childText = knownChildQuotas.length
          ? `${formatTaskPercent(childQuota)}${knownChildQuotas.length < children.length ? '（部分样本）' : ''}`
          : '等待采样';
        row.append(textElement('p', 'session-scope-note', `总额度拆分：本任务累计 ${ownQuota === null ? '等待采样' : formatTaskPercent(ownQuota)}，子任务合计 ${childText}。并行耗时不重复累加；${latestTurnScopeText(session)}`));
        const key = safeText(session.id, session.title || `root-${start + index}`);
        const matchingChildren = tokens.length ? children.filter((child) => sessionMatches(child, tokens)) : [];
        const childSearchMatch = tokens.length > 0 && matchingChildren.length > 0;
        const restrictToMatches = childSearchMatch && !sessionMatches(session, tokens);
        const manuallyCollapsed = state.sessionAutoCollapsedIds.has(key);
        const expanded = state.expandedSessionIds.has(key) || (childSearchMatch && !manuallyCollapsed);
        const shownChildren = expanded ? (restrictToMatches ? matchingChildren : children) : [];
        const toggle = document.createElement('button');
        toggle.className = 'session-child-toggle button button-small button-quiet';
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.textContent = expanded
          ? (restrictToMatches ? '收起匹配子会话' : '收起子会话')
          : (matchingChildren.length ? `显示匹配子会话（${matchingChildren.length}）` : `展开子会话（${children.length}）`);
        toggle.addEventListener('click', () => {
          if (expanded) {
            state.expandedSessionIds.delete(key);
            if (childSearchMatch) state.sessionAutoCollapsedIds.add(key);
          } else {
            state.expandedSessionIds.add(key);
            state.sessionAutoCollapsedIds.delete(key);
          }
          renderSessionList(state.snapshot || {});
        });
        row.append(toggle);
        if (shownChildren.length > 0) {
          const childList = document.createElement('div');
          childList.className = 'session-child-list';
          childList.setAttribute('role', 'list');
          shownChildren.forEach((child, childIndex) => {
            const childRow = document.createElement('article');
            childRow.className = 'session-row session-row-child';
            childRow.setAttribute('role', 'listitem');
            const childTitle = safeText(child.title, `未命名子会话 ${childIndex + 1}`);
            const childHeader = document.createElement('div');
            childHeader.className = 'session-row-header';
            const childTitleBlock = document.createElement('div');
            childTitleBlock.className = 'session-title-block';
            const childTitleElement = textElement('h3', 'session-title', childTitle);
            childTitleElement.title = childTitle;
            childTitleBlock.append(childTitleElement);
            const childId = safeText(child.id, '—');
            const childIdElement = textElement('span', 'session-id', childId);
            childIdElement.title = childId;
            childTitleBlock.append(childIdElement);
            childHeader.append(childTitleBlock);
            childHeader.append(textElement('span', `status-chip ${statusClass(child.status)}`, statusLabel(child.status)));
            childRow.append(childHeader);
            const childMeta = document.createElement('div');
            childMeta.className = 'session-meta';
            const childModel = safeText(child.model, '—');
            const childModelElement = textElement('span', 'meta-item meta-title', childModel);
            childModelElement.title = childModel;
            childMeta.append(childModelElement);
            childMeta.append(textElement('span', 'meta-separator', '·'));
            childMeta.append(textElement('span', 'meta-item', safeText(child.reasoningEffort, '—')));
            childRow.append(childMeta);
            const childMetrics = sessionTotals(child);
            const childLine = document.createElement('div');
            childLine.className = 'session-stat-line';
            childLine.append(textElement('span', 'session-stat-line-block', `近${settings.retentionHours}小时任务耗时${formatDuration(childMetrics.totalElapsedSeconds)}，任务消耗额度${formatTaskPercent(childMetrics.totalEstimatedPercent)}，平均每 1% 额度能撑 ${formatDuration(childMetrics.averageSecondsPerPercent)}；`));
            childLine.append(textElement('span', 'session-stat-line-block', `最近一次会话耗时${formatDuration(childMetrics.latestTurnElapsedSeconds)}，最近一次会话消耗额度${formatTaskPercent(childMetrics.latestTurnEstimatedPercent)}，预计接下来每 1% 额度能撑 ${formatDuration(childMetrics.secondsPerPercent)}`));
            childRow.append(childLine);
            const latestChildCount = finiteNumber(child.latestTurnChildCount);
            if (latestChildCount !== null && latestChildCount > 0) {
              childRow.append(textElement('p', 'session-scope-note', `最近一次含本轮启动的 ${Math.round(latestChildCount)} 个子任务。`));
            }
            childList.append(childRow);
          });
          row.append(childList);
        }
      }
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
    const incomplete = /lower-bound/.test(safeText(attribution.estimatedPercentCoverage, ''));
    const attributedTotal = !incomplete && observed !== null && observed > 0 && estimated !== null
      ? Math.min(100, Math.max(0, (estimated / observed) * 100))
      : null;
    const statusText = incomplete ? '等待完整记录' : observed === 0 ? '等待额度变化' : '等待采样';
    setText('attributionTotal', attributedTotal === null ? statusText : formatPercent(attributedTotal), '等待采样');
    $('attributionTotal')?.classList.toggle('attribution-status', attributedTotal === null);
    setText('observedPercent', observed === null || incomplete ? '等待采样' : formatPercent(observed), '等待采样');
    setText('estimatedPercent', estimated === null || incomplete ? '等待采样' : formatPercent(estimated), '等待采样');
    setText('unattributedPercent', incomplete || unattributed === null ? '等待采样' : formatPercent(unattributed), '等待采样');
    updateProgressBar('observedBar', observed);
    updateProgressBar('estimatedBar', estimated);
    updateProgressBar('unattributedBar', unattributed);
    const sinceDate = parseDate(attribution.since);
    setText('attributionSince', sinceDate ? `从 ${formatDate(sinceDate)}` : safeText(attribution.since, '等待样本'), '等待样本');
    setText('attributionWindow', safeText(attribution.windowLabel, '尚未收到窗口范围。'), '尚未收到窗口范围。');
    setText('attributionNote', `${attribution.excludedIncompleteHistory === true
      ? '已跳过较早的不完整记录，以上比例和额度从标注时间起计算。'
      : '以上比例和额度按统计窗口内的完整记录计算。'}任务总额度仍包含窗口内可用的历史估算；归因可能混入其他设备消耗。`);
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
      const staleText = account.stale === true ? '账户官方样本已过期；以下窗口值仅作参考。' : '';
      errorElement.textContent = error || staleText;
      errorElement.hidden = !(error || staleText);
      errorElement.classList.toggle('inline-warning', !error && Boolean(staleText));
    }
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

  function formatTrendStart(value, fallback = '时间待定') {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return fallback;
    try {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date).reduce((map, part) => {
        map[part.type] = part.value;
        return map;
      }, {});
      return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    } catch (_error) {
      return fallback;
    }
  }

  function renderTrend(snapshot) {
    const chart = $('trendChart');
    if (!chart) return;
    chart.replaceChildren();
    const history = isRecord(snapshot) && Array.isArray(snapshot.history) ? snapshot.history : [];
    const points = history
      .map((point) => ({
        at: parseDate(point && point.at),
        value: finiteNumber(point && point.remainingPercent),
        reset: point?.reset === true,
      }))
      .filter((point) => point.at !== null && point.value !== null && point.value >= 0 && point.value <= 100)
      .sort((a, b) => a.at - b.at);
    if (points.length === 0) {
      chart.append(textElement('div', 'empty-state chart-empty', '尚无趋势样本 · 完成本地读取后会出现'));
      setText('trendLatest', '等待历史样本', '等待历史样本');
      return;
    }
    const width = Math.max(240, Math.min(680, chart.clientWidth || 680));
    const height = 220;
    const padding = { top: 18, right: 20, bottom: 34, left: 56 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const values = points.map((point) => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const spread = Math.max(1, rawMax - rawMin);
    const min = Math.max(0, rawMin - spread * 0.12);
    const max = Math.min(100, rawMax + spread * 0.12);
    const firstAt = points[0].at.getTime();
    const timeSpan = points[points.length - 1].at.getTime() - firstAt;
    const scaleX = (index) => padding.left + (timeSpan <= 0 ? innerWidth / 2
      : (points[index].at.getTime() - firstAt) * innerWidth / timeSpan);
    const gapMs = Math.max(90_000, getSettings(snapshot).quotaPollSeconds * 3_000);
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
    const pointPosition = (index) => `${scaleX(index).toFixed(2)} ${scaleY(points[index].value).toFixed(2)}`;
    const gapSegments = [];
    const pathData = points.map((point, index) => {
      const gap = index > 0 && point.at - points[index - 1].at > gapMs;
      if (gap) gapSegments.push(`M ${pointPosition(index - 1)} L ${pointPosition(index)}`);
      return `${index === 0 || gap ? 'M' : 'L'} ${pointPosition(index)}`;
    }).join(' ');
    if (gapSegments.length) {
      const bridge = createSvgElement('path', {
        d: gapSegments.join(' '), class: 'trend-gap-line', fill: 'none',
        'aria-label': '暗线连接缺失或损坏区间两端的已知样本，仅作连线参考',
      });
      svg.append(bridge);
    }
    svg.append(createSvgElement('path', { d: pathData, class: 'trend-line', fill: 'none' }));
    points.forEach((point, index) => {
      const circle = createSvgElement('circle', {
        cx: scaleX(index),
        cy: scaleY(point.value),
        r: points.length > 30 ? 1 : 4,
        class: 'trend-point',
      });
      circle.setAttribute('aria-label', `${point.reset ? '额度重置后 ' : ''}${formatPercent(point.value)} ${formatDate(point.at, '')}`.trim());
      svg.append(circle);
    });
    const first = points[0];
    const last = points[points.length - 1];

    const valueLabelY = (point) => {
      const pointY = scaleY(point.value);
      const above = pointY > padding.top + 24;
      const preferred = above ? pointY - 12 : pointY + 18;
      return Math.max(padding.top + 11, Math.min(height - padding.bottom - 10, preferred));
    };
    const appendValueLabel = (point, text, anchor, className, xOffset) => {
      const label = createSvgElement('text', {
        x: scaleX(point === first ? 0 : points.length - 1) + xOffset,
        y: valueLabelY(point),
        'text-anchor': anchor,
        class: `trend-value-label ${className}`,
      });
      label.textContent = text;
      svg.append(label);
    };

    if (points.length === 1) {
      appendValueLabel(first, `起点 / 最新 ${formatPercent(first.value)}`, 'middle', 'trend-latest-label', 0);
    } else {
      appendValueLabel(first, `${width < 420 ? '' : '起点 '}${formatPercent(first.value)}`, 'start', 'trend-first-label', 8);
      appendValueLabel(last, `${width < 420 ? '' : '最新 '}${formatPercent(last.value)}`, 'end', 'trend-latest-label', -8);
    }
    const firstLabel = createSvgElement('text', { x: padding.left, y: height - 10, class: 'chart-axis-label' });
    firstLabel.textContent = formatDate(first.at, '开始');
    svg.append(firstLabel);
    const lastLabel = createSvgElement('text', { x: width - padding.right, y: height - 10, 'text-anchor': 'end', class: 'chart-axis-label' });
    lastLabel.textContent = formatDate(last.at, '现在');
    svg.append(lastLabel);
    chart.append(svg);
    const firstTimedPoint = points.find((point) => point.at);
    setText('trendLatest', `统计自 ${formatTrendStart(firstTimedPoint && firstTimedPoint.at)}`, '等待历史样本');
  }

  function renderModelOverview(snapshot) {
    const overview = isRecord(snapshot) && isRecord(snapshot.modelOverview) ? snapshot.modelOverview : {};
    const list = $('modelOverviewList');
    const rawRows = Array.isArray(overview.rows) ? overview.rows.filter((row) => isRecord(row)) : [];
    const groupsById = new Map();
    rawRows.forEach((row) => {
      const model = safeText(row.model, '');
      if (!model) return;
      const sourceKind = safeText(row.sourceKind, '').toLowerCase();
      const sourceLabel = safeText(row.sourceLabel, '');
      const meaningfulSource = sourceKind && !['unknown', 'unavailable', 'unsupported'].includes(sourceKind);
      const hasReference = row.available === true
        || finiteNumber(row.secondsPerPercent) !== null
        || finiteNumber(row.quotaPercentPerHour) !== null
        || finiteNumber(row.referenceCostPerHour) !== null
        || Boolean(sourceLabel && sourceLabel !== '—')
        || meaningfulSource;
      if (!hasReference) return;
      const group = groupsById.get(model) || { id: model, displayName: safeText(row.displayName, model), rows: [] };
      group.rows.push(row);
      if (!group.displayName || group.displayName === group.id) group.displayName = safeText(row.displayName, group.id);
      groupsById.set(model, group);
    });
    const groups = [...groupsById.values()];
    const effortRank = (row) => {
      const effort = safeText(row.effort || row.reasoningEffort, '').toLowerCase();
      const index = EFFORT_ORDER.indexOf(effort);
      return index < 0 ? EFFORT_ORDER.length : index;
    };
    groups.forEach((group) => {
      const byEffort = new Map();
      group.rows.sort((a, b) => effortRank(a) - effortRank(b)).forEach((row) => {
        const effort = safeText(row.effort || row.reasoningEffort, '—');
        if (!byEffort.has(effort)) byEffort.set(effort, row);
      });
      group.rows = [...byEffort.values()];
    });
    if (state.modelSelectedId && groups.some((group) => group.id === state.modelSelectedId)) {
      state.modelPage = groups.findIndex((group) => group.id === state.modelSelectedId);
    } else {
      state.modelPage = Math.min(Math.max(0, state.modelPage), Math.max(0, groups.length - 1));
      state.modelSelectedId = groups[state.modelPage]?.id || null;
    }
    const activeGroup = groups[state.modelPage] || null;
    const select = $('modelSelect');
    if (select) {
      select.replaceChildren();
      groups.forEach((group) => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.displayName === group.id ? group.id : `${group.displayName} · ${group.id}`;
        select.append(option);
      });
      select.value = activeGroup ? activeGroup.id : '';
    }
    const prev = $('modelPrev');
    const next = $('modelNext');
    const pageInfo = $('modelPageInfo');
    if (prev) prev.disabled = groups.length === 0 || state.modelPage <= 0;
    if (next) next.disabled = groups.length === 0 || state.modelPage >= groups.length - 1;
    setText('modelPageInfo', groups.length === 0 ? '无模型数据' : `${state.modelPage + 1} / ${groups.length}`, '无模型数据');
    setText('modelOverviewModelName', activeGroup ? activeGroup.displayName : '等待模型数据', '等待模型数据');
    setText('modelOverviewModelId', activeGroup ? activeGroup.id : '—', '—');
    if (list) {
      list.replaceChildren();
      if (!activeGroup) {
        list.append(textElement('div', 'empty-state model-overview-empty', '暂无模型速率数据 · 等待账户和观测样本'));
      } else {
        const sourceGroups = new Map();
        activeGroup.rows.forEach((row) => {
          const effort = safeText(row.effort || row.reasoningEffort, '—');
          const kind = safeText(row.sourceKind, '').toLowerCase();
          const sourceLabel = safeText(row.sourceLabel, '来源待定');
          const basis = safeText(row.rateBasis, '');
          let phrase = sourceLabel;
          if (!phrase || phrase === '来源待定') phrase = kind.includes('radar') || kind.includes('reference') ? 'Codex Radar参考推算' : kind.includes('local') || kind.includes('observ') ? '本机观测估算' : '来源待定';
          if (basis && basis !== phrase) phrase = `${phrase}（${basis}）`;
          const key = phrase;
          const record = sourceGroups.get(key) || { phrase, efforts: [] };
          record.efforts.push(effort);
          sourceGroups.set(key, record);
        });
        const basisElement = $('modelOverviewBasis');
        if (basisElement) {
          basisElement.replaceChildren();
          if (sourceGroups.size === 0) {
            basisElement.append(textElement('p', '', '来源说明等待数据。'));
          } else {
            sourceGroups.forEach((record) => basisElement.append(textElement('p', 'model-overview-basis-group', `${record.efforts.join('/')}：${record.phrase}`)));
          }
        }
        activeGroup.rows.forEach((row) => {
          const item = document.createElement('article');
          item.className = 'model-overview-row';
          item.setAttribute('role', 'listitem');
          const effort = safeText(row.effort || row.reasoningEffort, '—');
          const header = document.createElement('div');
          header.className = 'model-overview-header';
          header.append(textElement('span', 'effort-chip', effort));
          item.append(header);
          const metrics = document.createElement('div');
          metrics.className = 'model-overview-metrics';
          const seconds = finiteNumber(row.secondsPerPercent);
          const quotaPerHour = finiteNumber(row.quotaPercentPerHour);
          const referenceCost = finiteNumber(row.referenceCostPerHour);
          [['每1%时间', seconds === null || seconds <= 0 ? '—' : formatDuration(seconds, '—')], ['额度速率', quotaPerHour === null ? '—' : `${quotaPerHour.toFixed(2)}%/时`], ['参考成本', referenceCost === null ? '—' : `$${referenceCost.toFixed(2)}/时`]].forEach(([label, value]) => {
            const metric = document.createElement('div');
            metric.className = 'model-overview-metric';
            metric.append(textElement('span', '', label));
            metric.append(textElement('strong', '', value));
            metrics.append(metric);
          });
          item.append(metrics);
          list.append(item);
        });
      }
    }
    if (!activeGroup) {
      const basisElement = $('modelOverviewBasis');
      if (basisElement) {
        basisElement.replaceChildren(textElement('p', '', '来源说明等待数据。'));
      }
    }
    const updated = parseDate(overview.updatedAt);
    setText('modelOverviewUpdated', updated ? `更新于 ${formatDate(updated)}` : '等待数据', '等待数据');
    setText('modelOverviewNote', safeText(overview.note, '模型速率只用于横向参考，不把 API 美元成本换算成订阅百分比。'), '模型速率只用于横向参考，不把 API 美元成本换算成订阅百分比。');
    const source = safeText(overview.sourceUrl, '等待数据');
    const sourceElement = $('modelOverviewSource');
    if (sourceElement) {
      sourceElement.replaceChildren();
      let sourceUrl = null;
      try {
        const parsed = new URL(source);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') sourceUrl = parsed.href;
      } catch (_error) {
        sourceUrl = null;
      }
      if (sourceUrl) {
        const link = document.createElement('a');
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `来源：${source}`;
        sourceElement.append(link);
      } else {
        sourceElement.textContent = `来源：${source}`;
      }
    }
    setText('modelOverviewReference', 'API参考成本仅作外部价格参考，不等于订阅额度百分比。', '— 表示无可用样本');
  }

  function renderRecommendation(snapshot) {
    renderModelOverview(snapshot);
    const choice = isRecord(snapshot.recommendation) ? snapshot.recommendation : {};
    setText('defaultModelTarget', choice.model ? `默认目标：${choice.model} / ${safeText(choice.reasoningEffort, '—')}` : '默认目标尚未确定');
    const choiceError = $('defaultModelError');
    if (choiceError) {
      choiceError.textContent = choice.error ? safeError(choice.error) : '';
      choiceError.hidden = !choice.error;
    }
    const settings = getSettings(snapshot);
    const objective = $('objectiveSelect');
    const autoSwitch = $('autoSwitchCheckbox');
    const restore = $('restoreDefaultsBtn');
    if (objective && document.activeElement !== objective) objective.value = settings.objective;
    if (autoSwitch && document.activeElement !== autoSwitch) autoSwitch.checked = settings.autoSwitch;
    if (restore) restore.disabled = state.restoreSaving || state.mode !== 'live' || state.offline;
  }

  function renderReset(snapshot) {
    const reset = isRecord(snapshot) && isRecord(snapshot.reset) ? snapshot.reset : {};
    const stale = reset.stale === true;
    const resetSeconds = stale ? null : finiteNumber(reset.secondsUntil);
    state.resetBaseSeconds = resetSeconds;
    state.resetBaseAt = resetSeconds === null ? null : Date.now();
    state.resetScheduledAt = reset.scheduledAt;
    const officialStat = $('officialResetStat');
    if (officialStat) officialStat.classList.toggle('reset-stat-stale', stale);
    const resetLabel = state.mode === 'demo'
      ? '此额度窗口的重置（演示）'
      : stale
        ? '此额度窗口的官方重置（样本已过期）'
        : '此额度窗口的官方重置';
    setText('officialResetLabel', resetLabel, '此额度窗口的官方重置');
    setText('exhaustionLabel', state.mode === 'demo' ? '本机速率耗尽估计（演示）' : '本机速率耗尽估计', '本机速率耗尽估计');
    setText('officialResetCountdown', stale ? '官方数据暂不可用' : resetSeconds === null ? '等待数据' : formatShortDuration(resetSeconds), '等待数据');
    const resetSource = safeText(reset.source, 'account/rateLimits/read');
    const resetTimezone = safeText(reset.timezone, 'Asia/Shanghai');
    const timezoneSuffix = resetTimezone === 'Asia/Shanghai' ? '' : ` · 时区 ${resetTimezone}`;
    const resetTime = reset.scheduledAt
      ? formatBeijingDateTime(reset.scheduledAt)
      : stale && reset.lastKnownScheduledAt
        ? `上次已知 ${formatBeijingDateTime(reset.lastKnownScheduledAt)}`
        : '官方时间待定';
    setText('officialResetAt', `${resetTime} · ${resetSource}${timezoneSuffix}${stale ? ' · 样本已过期' : ''}`, '官方时间待定');
    const exhaustionDate = stale ? null : parseDate(reset.exhaustionAt);
    state.exhaustionAt = reset.exhaustionAt;
    setText('exhaustionEstimate', exhaustionDate ? formatShortDuration((exhaustionDate.getTime() - Date.now()) / 1000, '已到期') : '等待速率样本', '等待速率样本');
    setText('exhaustionAt', exhaustionDate ? formatDate(exhaustionDate) : '当前速率尚无可用估计', '当前速率尚无可用估计');
    const unexpected = safeText(reset.unexpected, 'unknown').toLowerCase();
    setText('unexpectedReset', !unexpected || unexpected === 'unknown' ? '未知' : safeText(reset.unexpected), '未知');
  }

  function renderResetRadar(snapshot) {
    const radar = isRecord(snapshot) && isRecord(snapshot.resetRadar) ? snapshot.resetRadar : {};
    const list = $('confirmedGlobalResetList');
    const evidenceKey = (scope, parent, entry, index) => {
      const parentKey = safeText(parent.id, `${safeText(parent.title, 'item')}|${safeText(parent.announcementAt || parent.eventAt, '')}`);
      const entryKey = safeText(entry.url, `${safeText(entry.author, '')}|${safeText(entry.publishedAt, '')}|${safeText(entry.label, '')}|${index}`);
      return `${scope}|${parentKey}|${entryKey}`;
    };
    const persistentDetails = (key, summaryText) => {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = summaryText;
      details.append(summary);
      details.addEventListener('toggle', () => {
        if (details.open) state.resetEvidenceExpanded.add(key);
        else state.resetEvidenceExpanded.delete(key);
      });
      details.open = state.resetEvidenceExpanded.has(key);
      return details;
    };
    const confirmed = Array.isArray(radar.confirmed) ? radar.confirmed.filter((item) => isRecord(item)) : [];
    const ordered = confirmed.slice().sort((a, b) => {
      const aTime = parseDate(a.announcementAt || a.eventAt)?.getTime() || 0;
      const bTime = parseDate(b.announcementAt || b.eventAt)?.getTime() || 0;
      return bTime - aTime;
    }).slice(0, 2);
    setText('confirmedGlobalUpdated', radar.updatedAt ? `更新于 ${formatBeijingDateTime(radar.updatedAt)}` : '等待数据', '等待数据');
    if (list) {
      list.replaceChildren();
      if (ordered.length === 0) {
        list.append(textElement('div', 'empty-state', '暂无官方全局重置完成公告'));
      } else {
        ordered.forEach((item) => {
          const card = document.createElement('article');
          card.className = 'confirmed-reset-item';
          card.setAttribute('role', 'listitem');
          const title = safeText(item.title, '官方全局重置完成公告');
          const titleNode = textElement('strong', '', title);
          titleNode.title = title;
          card.append(titleNode);
          const precision = ({'announcement-only':'公告时间','date-only':'仅精确到日期','effective':'已公布生效时间','observed':'观察记录时间'})[item.timePrecision] || safeText(item.timePrecision, '未说明');
          const announcement = item.announcementAt ? `公告时间：${formatBeijingDateTime(item.announcementAt)}` : '公告时间：未提供';
          const event = item.eventAt ? `已确认事件：${formatBeijingDateTime(item.eventAt)}` : '未提供逐账户到账时刻';
          card.append(textElement('span', '', `${announcement} · ${event}`));
          card.append(textElement('small', '', `时间精度：${precision}`));
          const reason = safeText(item.reason, '原因未提供');
          card.append(textElement('small', '', `原因：${reason}`));
          const evidence = Array.isArray(item.evidence) ? item.evidence.filter((entry) => isRecord(entry)) : [];
          evidence.forEach((entry, index) => {
            const details = persistentDetails(
              evidenceKey('confirmed', item, entry, index),
              `证据 ${index + 1} · ${safeText(entry.author, '作者未提供')} · ${entry.publishedAt ? formatBeijingDateTime(entry.publishedAt) : '发布时间未提供'}`,
            );
            const excerpt = safeText(entry.excerpt || entry.summary || entry.detail, '证据摘要未提供');
            details.append(textElement('p', '', excerpt));
            const url = safeText(entry.url, '');
            try {
              const parsed = new URL(url);
              if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                const link = document.createElement('a');
                link.href = parsed.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = '打开证据链接 ↗';
                details.append(link);
              }
            } catch (_error) {
              // Ignore non-web evidence URLs.
            }
            card.append(details);
          });
          list.append(card);
        });
      }
    }

    const forecast = isRecord(radar.forecast) ? radar.forecast : {};
    const probabilityText = (value) => {
      const number = finiteNumber(value);
      return number === null ? '—' : `${(Math.min(1, Math.max(0, number)) * 100).toFixed(2)}%`;
    };
    setText('forecastProbability24h', finiteNumber(forecast.probability24hPercent) === null ? probabilityText(forecast.probability24h) : `${forecast.probability24hPercent}%`, '—');
    setText('forecastProbability48h', finiteNumber(forecast.probability48hPercent) === null ? probabilityText(forecast.probability48h) : `${forecast.probability48hPercent}%`, '—');
    setText('forecastConfidence', ({low:'低',medium:'中',high:'高',unknown:'—'})[forecast.confidence] || safeText(forecast.confidence, '—'), '—');
    const stateLabel = ({experimental:'暂无新的官方预告 · 实验模型','no-official-window':'暂无官方时间窗口','official-window':'已收录官方预告窗口'})[forecast.state] || safeText(forecast.state, '未宣布');
    setText('forecastState', `第三方参考状态：${stateLabel}`, '第三方参考状态：未宣布');
    const start = forecast.windowStart ? formatBeijingDateTime(forecast.windowStart) : null;
    const end = forecast.windowEnd ? formatBeijingDateTime(forecast.windowEnd) : null;
    const windowLabel = forecast.officialWindow ? '站点收录的官方预告窗口' : '参考观察窗';
    setText('forecastWindow', start || end ? `${windowLabel}：${start || '起点未说明'} 至 ${end || '终点未说明'}` : '参考观察窗：未宣布', '参考观察窗：未宣布');
    setText('forecastCalculation', `${safeText(forecast.timeBasis, '')} ${safeText(forecast.calculation, '暂无算法摘要')}`, '暂无计算依据');
    setText('forecastReason', `${safeText(forecast.reason, '暂无第三方理由')} · 不承诺一定发生，也不代表官方信号。`, '预测不承诺一定发生，也不代表官方信号。');
    const forecastCard = $('thirdPartyForecast');
    const expires = parseDate(forecast.expiresAt);
    const forecastExpired = forecast.stale === true || Boolean(expires && expires.getTime() <= Date.now());
    if (forecastCard) forecastCard.classList.toggle('forecast-stale', forecastExpired);
    const forecastUpdated = forecast.updatedAt || radar.updatedAt;
    setText('forecastUpdated', forecastExpired ? '非官方 · 已过期' : forecastUpdated ? `非官方 · 更新于 ${formatBeijingDateTime(forecastUpdated)}` : '非官方 · 等待数据', '非官方 · 等待数据');
    const evidenceContainer = $('forecastEvidence');
    if (evidenceContainer) {
      evidenceContainer.replaceChildren();
      const methodology = safeText(radar.methodologyUrl, '');
      const source = safeText(radar.sourceUrl, '');
      [methodology ? ['方法说明', methodology] : null, source ? ['来源', source] : null].filter(Boolean).forEach(([label, url]) => {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
          const link = document.createElement('a');
          link.href = parsed.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = `${label} ↗`;
          evidenceContainer.append(link);
        } catch (_error) {
          // Ignore non-web links.
        }
      });
      const evidence = Array.isArray(forecast.evidence) ? forecast.evidence.filter((entry) => isRecord(entry)) : [];
      evidence.forEach((entry, index) => {
        const details = persistentDetails(
          evidenceKey('forecast', forecast, entry, index),
          entry.author ? `预测依据 ${index + 1} · ${entry.author}${entry.publishedAt ? ` · ${formatBeijingDateTime(entry.publishedAt)}` : ''}` : `预测依据 ${index + 1} · ${safeText(entry.label, '历史统计')}`,
        );
        details.append(textElement('p', '', safeText(entry.excerpt || entry.summary || entry.detail, '证据摘要未提供')));
        try {
          const parsed = new URL(safeText(entry.url, ''));
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            const link = document.createElement('a');
            link.href = parsed.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '打开证据链接 ↗';
            details.append(link);
          }
        } catch (_error) {
          // Ignore non-web links.
        }
        evidenceContainer.append(details);
      });
    }
    const notes = Array.isArray(radar.notes) ? radar.notes.filter((note) => typeof note === 'string' && note.trim()) : [];
    if (radar.fetchError) notes.unshift('来源刷新失败：显示最后可用资料');
    setText('resetRadarNotes', notes.length ? notes.join(' · ') : '观察窗口和第三方概率仅供参考，不承诺一定发生。', '观察窗口和第三方概率仅供参考，不承诺一定发生。');
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

  function renderOfflineState() {
    document.body.classList.toggle('is-offline', state.offline);
    setHidden('offlinePanel', !state.offline);
    setHidden('hero', state.offline);
    setHidden('dashboardGrid', state.offline);
    setHidden('footer', state.offline);
  }

  function renderSettings(snapshot) {
    const settings = getSettings(snapshot);
    const poll = $('pollSecondsInput');
    const quotaPoll = $('quotaPollSecondsInput');
    const retention = $('retentionHoursInput');
    const paused = $('pausedCheckbox');
    if (poll && document.activeElement !== poll) poll.value = String(settings.pollSeconds);
    if (quotaPoll && document.activeElement !== quotaPoll) quotaPoll.value = String(settings.quotaPollSeconds);
    if (retention && document.activeElement !== retention) retention.value = String(settings.retentionHours);
    if (paused && document.activeElement !== paused) paused.checked = settings.paused;
    const reminder = $('restoreDisclaimerBtn');
    if (reminder) reminder.disabled = state.reminderSaving;
    if (!state.settingsSaving) setText('settingsSaveStatus', '设置已同步', '设置已同步');
  }

  function renderCountdowns() {
    if (state.resetBaseSeconds !== null && state.resetBaseAt !== null) {
      const elapsed = (Date.now() - state.resetBaseAt) / 1000;
      const remaining = state.resetBaseSeconds - elapsed;
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
    renderMode(snapshot);
    renderOfflineState();
    renderConnection(snapshot);
    renderGlobalError(safeSnapshot);
    renderOverview(safeSnapshot);
    renderSessionList(safeSnapshot);
    renderAccountWindows(safeSnapshot);
    renderAttribution(safeSnapshot);
    renderTrend(safeSnapshot);
    renderRecommendation(safeSnapshot);
    renderReset(safeSnapshot);
    renderResetRadar(safeSnapshot);
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
    if (state.offline) {
      state.pollTimer = null;
      return;
    }
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
        signal: AbortSignal.timeout(8000),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json();
      if (!isRecord(payload)) throw new Error('快照格式无效');
      state.snapshot = payload;
      state.error = null;
      state.offline = false;
      state.lastUpdatedAt = Date.now();
    } catch (error) {
      state.error = safeError(error, '读取快照失败');
      state.snapshot = null;
      state.offline = true;
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
    if (state.restoreSaving || state.mode !== 'live' || state.offline) return;
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
    document.querySelectorAll('a[href="#main"], a[href="#settings"], [data-target]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const targetId = link.dataset.target || link.getAttribute('href').slice(1);
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    const navToggle = $('sectionNavToggle');
    const nav = $('sectionNav');
    if (navToggle && nav) navToggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (nav) nav.addEventListener('pointerleave', (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      nav.classList.remove('is-open');
      if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
      const focused = document.activeElement;
      if (focused && nav.contains(focused) && !focused.matches(':focus-visible')) focused.blur();
    });
    const refresh = $('refreshBtn');
    const retry = $('retryBtn');
    if (refresh) refresh.addEventListener('click', () => fetchSnapshot());
    if (retry) retry.addEventListener('click', () => fetchSnapshot());

    const poll = $('pollSecondsInput');
    if (poll) poll.addEventListener('change', () => queueSettingsPatch({ pollSeconds: readIntegerInput('pollSecondsInput', 2, 300, 5) }));
    const quotaPoll = $('quotaPollSecondsInput');
    if (quotaPoll) quotaPoll.addEventListener('change', () => queueSettingsPatch({ quotaPollSeconds: readIntegerInput('quotaPollSecondsInput', 5, 3600, 30) }));
    const retention = $('retentionHoursInput');
    if (retention) retention.addEventListener('change', () => queueSettingsPatch({ retentionHours: readIntegerInput('retentionHoursInput', 1, 168, 24) }));
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

    const modelPrev = $('modelPrev');
    if (modelPrev) modelPrev.addEventListener('click', () => {
      state.modelPage = Math.max(0, state.modelPage - 1);
      state.modelSelectedId = null;
      renderModelOverview(state.snapshot || {});
    });
    const modelNext = $('modelNext');
    if (modelNext) modelNext.addEventListener('click', () => {
      state.modelPage += 1;
      state.modelSelectedId = null;
      renderModelOverview(state.snapshot || {});
    });
    const modelSelect = $('modelSelect');
    if (modelSelect) modelSelect.addEventListener('change', () => {
      state.modelSelectedId = modelSelect.value || null;
      renderModelOverview(state.snapshot || {});
    });

    const sessionSearch = $('sessionSearch');
    if (sessionSearch) sessionSearch.addEventListener('input', () => {
      state.sessionQuery = sessionSearch.value;
      state.sessionPage = 0;
      state.sessionAutoCollapsedIds.clear();
      renderSessionList(state.snapshot || {});
    });
    const clearSearch = $('clearSessionSearch');
    if (clearSearch) clearSearch.addEventListener('click', () => {
      state.sessionQuery = '';
      state.sessionPage = 0;
      state.sessionAutoCollapsedIds.clear();
      if (sessionSearch) {
        sessionSearch.value = '';
        sessionSearch.focus();
      }
      renderSessionList(state.snapshot || {});
    });
    const previous = $('sessionPrev');
    if (previous) previous.addEventListener('click', () => {
      state.sessionPage = Math.max(0, state.sessionPage - 1);
      renderSessionList(state.snapshot || {});
    });
    const next = $('sessionNext');
    if (next) next.addEventListener('click', () => {
      state.sessionPage += 1;
      renderSessionList(state.snapshot || {});
    });
    const expandMore = $('sessionExpandMore');
    if (expandMore) expandMore.addEventListener('click', () => {
      state.sessionPageSize += 5;
      state.sessionPage = 0;
      renderSessionList(state.snapshot || {});
    });
    const resetPageSize = $('sessionResetPageSize');
    if (resetPageSize) resetPageSize.addEventListener('click', () => {
      state.sessionPageSize = 5;
      state.sessionPage = 0;
      renderSessionList(state.snapshot || {});
    });
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
    let trendResizeFrame = null;
    window.addEventListener('resize', () => {
      if (trendResizeFrame !== null) window.cancelAnimationFrame(trendResizeFrame);
      trendResizeFrame = window.requestAnimationFrame(() => {
        trendResizeFrame = null;
        if (state.snapshot) renderTrend(state.snapshot);
      });
    });
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
