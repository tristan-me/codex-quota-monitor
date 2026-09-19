import {
  formatTaskPercent, resetDeadline, orderSessionRows, filterSessionRows,
  moveSessionGroup, sessionSortPreference, sessionSortStorageKey,
} from './dashboard-utils.mjs';
import { createSessionChart, renderQuotaTrend, renderAttributionScopes } from './usage-charts.mjs';
(() => {
  'use strict';

  const API_SNAPSHOT = '/api/snapshot';
  const API_SETTINGS = '/api/settings';
  const DISCLAIMER_KEY = 'codexQuotaMonitor.disclaimerDismissed';
  const OBJECTIVES = new Set(['economy', 'balanced', 'quality']);
  const EFFORT_ORDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low'];

  const state = {
    snapshot: null,
    error: null,
    offline: false,
    mode: 'unknown',
    lastSettingsError: null,
    fetching: false,
    fetchPromise: null,
    providerChangeVersion: 0,
    providerSaving: false,
    pendingProviderId: null,
    providerError: null,
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
    sessionSortProviderId: null,
    sessionSort: 'time-desc',
    sessionManualOrder: [],
    sessionPreferences: new Map(),
    sessionRows: [],
    sessionDrag: null,
    expandedSessionIds: new Set(),
    sessionAutoCollapsedIds: new Set(),
    modelPage: 0,
    modelSelectedId: null,
    resetEvidenceExpanded: new Set(),
    resetDeadline: null,
    resetScheduledAt: null,
    exhaustionAt: null,
    lastFocusBeforeModal: null,
  };

  const $ = (id) => document.getElementById(id);
  const codexProviderCopy = new Map();

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

  function formatResetCountdown(value) {
    const parsed = finiteNumber(value);
    if (parsed === null) return '等待数据';
    if (parsed <= 0) return '已到期，等待官方更新';
    const seconds = Math.ceil(parsed);
    const days = Math.floor(seconds / 86400);
    const clock = [Math.floor(seconds % 86400 / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
    return `${days ? `${days}天 ` : ''}${clock}`;
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
      pollSeconds: boundedNumber(source.pollSeconds, 5, 5, 3600),
      quotaPollSeconds: boundedNumber(source.pollSeconds ?? source.quotaPollSeconds, 5, 5, 3600),
      retentionHours: boundedNumber(source.retentionHours, 24, 1, 168),
      paused: source.paused === true,
      autoSwitch: source.autoSwitch === true,
      hideDisclaimer: source.hideDisclaimer === true,
      objective,
    };
  }

  function providerSelectionFrom(snapshot) {
    const source = isRecord(snapshot) && isRecord(snapshot.providerSelection) ? snapshot.providerSelection : null;
    const codex = { id: 'openai', name: 'Codex 账号', kind: 'codex' };
    if (!source) return { available: false, selected: codex, active: null, providers: [codex] };
    const providersById = new Map();
    const entries = Array.isArray(source.providers) ? source.providers : [];
    entries.filter(isRecord).forEach((entry) => {
      const id = safeText(entry.id, '');
      if (!id) return;
      const kind = id === 'openai' || entry.kind === 'codex' ? 'codex' : entry.kind === 'api' ? 'api' : 'unknown';
      providersById.set(id, { id, kind, name: kind === 'codex' ? 'Codex 账号' : safeText(entry.name, id === 'muse' ? 'Muse' : id) });
    });
    const selectedId = safeText(source.selectedId, safeText(source.activeId, 'openai'));
    if (!providersById.has(selectedId)) {
      const usage = isRecord(snapshot.apiUsage) && snapshot.apiUsage.providerId === selectedId ? snapshot.apiUsage : {};
      providersById.set(selectedId, selectedId === 'openai' ? codex : {
        id: selectedId, name: safeText(usage.providerName, selectedId === 'muse' ? 'Muse' : selectedId), kind: 'unknown',
      });
    }
    const activeId = safeText(source.activeId, '');
    const active = activeId ? providersById.get(activeId) || (activeId === 'openai' ? codex : {
      id: activeId, name: activeId === 'muse' ? 'Muse' : activeId, kind: 'unknown',
    }) : null;
    return { available: true, selected: providersById.get(selectedId), active, providers: [...providersById.values()] };
  }

  function isApiProvider(snapshot) {
    return providerSelectionFrom(snapshot).selected.kind !== 'codex';
  }

  function apiUsageFrom(snapshot) {
    const usage = isRecord(snapshot) && isRecord(snapshot.apiUsage) ? snapshot.apiUsage : null;
    return usage && usage.providerId === providerSelectionFrom(snapshot).selected.id ? usage : null;
  }

  function apiSessionsFrom(snapshot) {
    const usage = apiUsageFrom(snapshot);
    return usage && Array.isArray(usage.sessions) ? usage.sessions.filter(isRecord) : null;
  }

  function hasRecordedApiUsage(record) {
    return isRecord(record) && (finiteNumber(record.totalTokens) > 0 || finiteNumber(record.turnCount) > 0);
  }

  function formatApiTokenCount(record, key) {
    if (!hasRecordedApiUsage(record)) return '—';
    const value = finiteNumber(record[key]);
    if (value === null || value < 0) return '—';
    if (key !== 'totalTokens' && key !== 'unclassifiedTokens' && value === 0 && finiteNumber(record.unclassifiedTokens) > 0) return '—';
    return formatTokenCount(value);
  }

  function renderProviderSelection(snapshot) {
    const selection = providerSelectionFrom(snapshot);
    const api = selection.selected.kind !== 'codex';
    document.body.classList.toggle('api-provider', api);
    document.querySelectorAll('[data-provider-view]').forEach((element) => {
      element.hidden = element.dataset.providerView !== (api ? 'api' : 'codex');
    });
    const select = $('providerSelect');
    if (select) {
      const signature = JSON.stringify(selection.providers.map(({ id, name }) => [id, name]));
      if (select.dataset.providers !== signature) {
        select.replaceChildren(...selection.providers.map((provider) => {
          const option = textElement('option', '', provider.name);
          option.value = provider.id;
          return option;
        }));
        select.dataset.providers = signature;
      }
      select.value = state.pendingProviderId || selection.selected.id;
      select.disabled = !selection.available || state.offline || state.providerSaving || Boolean(state.sessionDrag);
      select.setAttribute('aria-busy', state.providerSaving ? 'true' : 'false');
    }
    setText('selectedProviderBadge', `正在查看：${selection.selected.name}`);
    setText('activeProviderLabel', selection.active ? `桌面当前使用：${selection.active.name}` : '');
    setHidden('activeProviderLabel', !selection.active);
    setText('providerSelectionStatus', state.providerSaving ? '切换中…' : state.providerError || '', '');
    $('providerSelectionStatus')?.classList.toggle('is-error', Boolean(state.providerError));

    const usage = apiUsageFrom(snapshot);
    const apiCopy = {
      overviewKicker: 'API 用量 · 已知记录',
      'overview-title': `${selection.selected.name} 的已记录用量`,
      monitorUsageNote: '监控只读取本地用量记录，不会发起模型推理请求。',
      sessionsKicker: 'API TASKS',
      'sessions-title': 'API 任务用量（已知记录）',
      sessionsNote: [
        `仅统计本机可读且归属于 ${selection.selected.name} 的任务记录。缓存输入已包含在总输入中；未分类 token 已计入合计，输入/输出只显示可确认部分。`,
        safeText(usage?.note, '历史未记录或不可读的部分无法补齐；这些数字不代表服务商余额或账单。'),
      ].join(' '),
      sessionSearchLabel: '筛选任务',
      sessionsNavLabel: '任务',
      pollSecondsHelp: '更新所选 API 的本地任务记录和页面，默认 5 秒。',
      footerNote: '本地任务记录 · API token 用量',
      disclaimerTitle: '先了解用量范围',
      disclaimerText: '本页汇总所选 API 已记录的任务用量，历史缺失记录无法补齐。输入包含缓存输入；未分类 token 已计入合计，未列入输入/输出拆分。“—”表示暂无可读记录或拆分不可用。服务商余额和实际费用请以服务商账单为准。',
    };
    Object.entries(apiCopy).forEach(([id, value]) => {
      const element = $(id);
      if (!element) return;
      if (!codexProviderCopy.has(id)) codexProviderCopy.set(id, element.textContent);
      element.textContent = api ? value : codexProviderCopy.get(id);
    });
    $('sessionsNavLink')?.setAttribute('title', api ? 'API 任务用量' : '会话消耗');
    $('sessionList')?.setAttribute('aria-label', api ? `${selection.selected.name} 任务列表` : 'Codex 会话列表');
    $('sessionPagination')?.setAttribute('aria-label', api ? '任务分页' : '会话分页');
  }

  function renderApiOverview(snapshot) {
    const usage = apiUsageFrom(snapshot);
    const summary = isRecord(usage?.summary) ? usage.summary : {};
    setText('apiInputTokens', formatApiTokenCount(summary, 'inputTokens'));
    setText('apiCachedInputTokens', formatApiTokenCount(summary, 'cachedInputTokens'));
    setText('apiOutputTokens', formatApiTokenCount(summary, 'outputTokens'));
    setText('apiTotalTokens', formatApiTokenCount(summary, 'totalTokens'));
    const hasUsage = hasRecordedApiUsage(summary);
    const unclassified = finiteNumber(summary.unclassifiedTokens);
    setText('apiTokenCoverage', !hasUsage
      ? '暂无可读的 token 用量；“—”表示未记录，不代表零消耗。'
      : unclassified > 0
        ? `未分类 token：${formatTokenCount(unclassified)}，已计入合计。分项仅显示可确认部分；“—”表示拆分不可用。以上用量为已知下限。`
        : '以上用量为已知记录的下限，未读取的历史用量无法补齐。');
    const since = parseDate(usage?.since);
    const until = parseDate(usage?.until);
    setText('apiUsageRange', hasUsage && since
      ? `已知记录范围：${formatDate(since)}${until ? ` — ${formatDate(until)}` : '起'}`
      : '等待所选 API 的可读用量记录');
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
    if (isApiProvider(snapshot)) {
      const usage = apiUsageFrom(snapshot);
      const sessions = apiSessionsFrom(snapshot);
      if (!sessions) return '等待 API 任务记录';
      const summary = isRecord(usage.summary) ? usage.summary : {};
      const taskCount = finiteNumber(summary.taskCount) ?? sessions.length;
      const activeCount = finiteNumber(summary.activeTaskCount) ?? sessions.filter((session) => isActiveStatus(session.status)).length;
      const turns = finiteNumber(summary.turnCount);
      return `${formatTokenCount(taskCount)} 个任务 · ${formatTokenCount(activeCount)} 个活跃${hasRecordedApiUsage(summary) ? turns === null ? '' : ` · 已记录 ${formatTokenCount(turns)} 轮` : ' · 暂无可读用量'}`;
    }
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
    const api = isApiProvider(snapshot);
    const provider = providerSelectionFrom(snapshot).selected;
    const account = isRecord(snapshot) && isRecord(snapshot.account) ? snapshot.account : {};
    if (api && mode === 'live') {
      copy.label = `${provider.name} · 本地用量记录`;
      copy.detail = '显示所选 API 已记录的 token 用量；仅切换监控视图，不改变任务使用的 API。';
    } else if (api && mode === 'demo') {
      copy.label = '演示数据，不是你的 API 任务';
      copy.detail = '合成任务与 token 用量仅用于预览。';
    } else if (api && mode === 'unknown') {
      copy.detail = '等待服务声明 live 或 demo；当前用量记录的数据来源待确认。';
    } else if (mode === 'live' && account.stale === true) {
      copy.detail = '账户官方样本已过期；以下数字保留作参考，不代表实时额度。';
    }
    const banner = $('modeBanner');
    if (banner) {
      banner.classList.remove('mode-live', 'mode-demo', 'mode-offline', 'mode-unknown', 'is-stale');
      banner.classList.add(`mode-${mode}`);
      if (!api && mode === 'live' && account.stale === true) banner.classList.add('is-stale');
    }
    const titles = {
      live: 'Codex 额度监控器',
      demo: '演示数据 · Codex 额度监控器',
      offline: '服务离线 · Codex 额度监控器',
      unknown: '数据源未声明 · Codex 额度监控器',
    };
    document.title = titles[mode] || titles.unknown;
    if (api) document.title = `${mode === 'demo' ? '演示数据 · ' : ''}${provider.name} 用量 · Codex 额度监控器`;
    setText('modeBannerLabel', copy.label, '数据源未声明');
    setText('modeBannerDetail', copy.detail, '等待服务声明 live 或 demo；请先确认数据来源。');
    const watermark = $('demoWatermark');
    if (watermark) {
      watermark.hidden = mode !== 'demo';
      watermark.setAttribute('aria-hidden', mode === 'demo' ? 'false' : 'true');
    }
    const allowModelOperations = mode === 'live' && !state.offline && !api && !state.providerSaving;
    const objective = $('objectiveSelect');
    const autoSwitch = $('autoSwitchCheckbox');
    const restoreDefaults = $('restoreDefaultsBtn');
    if (objective) objective.disabled = !allowModelOperations;
    if (autoSwitch) {
      autoSwitch.disabled = !allowModelOperations;
      if (api) autoSwitch.checked = false;
    }
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
      : `${status}${isApiProvider(snapshot) ? ` · ${providerSelectionFrom(snapshot).selected.name}` : ''} · 每 ${settings.pollSeconds} 秒刷新 · ${updated}${settings.paused ? ' · 后台读取暂停' : ''}`;
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
      totalEstimatedPercent: sessionMetric(session, 'totalEstimatedPercent', 'estimatedPercent', true),
      averageSecondsPerPercent: sessionMetric(session, 'averageSecondsPerPercent', 'averageSecondsPerPercent'),
    };
  }

  function syncSessionSort(snapshot) {
    const providerId = providerSelectionFrom(snapshot).selected.id;
    if (state.sessionSortProviderId !== providerId) {
      let preference = state.sessionPreferences.get(providerId);
      if (!preference) {
        try {
          preference = sessionSortPreference(JSON.parse(window.localStorage.getItem(sessionSortStorageKey(providerId))));
        } catch (_error) {
          preference = sessionSortPreference(null);
        }
        state.sessionPreferences.set(providerId, preference);
      }
      state.sessionSortProviderId = providerId;
      state.sessionSort = preference.sort;
      state.sessionManualOrder = preference.order;
      state.sessionPage = 0;
    }
    const select = $('sessionSort');
    if (select) {
      select.value = state.sessionSort;
      select.disabled = Boolean(state.sessionDrag) || state.providerSaving;
    }
  }

  function saveSessionSort() {
    const preference = sessionSortPreference({ sort: state.sessionSort, order: state.sessionManualOrder });
    const providerId = state.sessionSortProviderId;
    if (!providerId) return;
    state.sessionPreferences.set(providerId, preference);
    try {
      window.localStorage.setItem(sessionSortStorageKey(providerId), JSON.stringify(preference));
    } catch (_error) {
      // The in-memory preference still survives polling and provider switches.
    }
  }

  function sortedSessionRows(sessions, providerKind) {
    state.sessionRows = orderSessionRows(sessions, {
      sort: state.sessionSort,
      providerKind,
      manualOrder: state.sessionManualOrder,
    });
    return state.sessionRows;
  }

  function groupSessionRows(rows) {
    const groups = [];
    rows.forEach(entry => {
      if (entry.depth === 0) groups.push({ root: entry, children: [] });
      else groups.at(-1)?.children.push(entry);
    });
    return groups;
  }

  function clearSessionDropMarker() {
    $('sessionList')?.querySelectorAll('.is-drop-before, .is-drop-after').forEach(row => {
      row.classList.remove('is-drop-before', 'is-drop-after');
    });
  }

  function finishSessionDrag() {
    const drag = state.sessionDrag;
    if (!drag) return;
    const restoreFocus = document.activeElement === drag.handle;
    state.sessionDrag = null;
    if (drag.handle?.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    clearSessionDropMarker();
    $('sessionList')?.querySelectorAll('.is-dragging').forEach(row => row.classList.remove('is-dragging'));
    document.body.classList.remove('session-drag-active');
    // Release pointer capture before applying the newest polled snapshot.
    window.requestAnimationFrame(() => {
      render(state.snapshot || {});
      if (restoreFocus) [...($('sessionList')?.querySelectorAll('[data-session-id]') || [])]
        .find(row => row.dataset.sessionId === drag.sourceId)?.querySelector('.session-drag-handle')?.focus({ preventScroll: true });
    });
  }

  function applyManualSessionOrder(result) {
    if (!result) return;
    state.sessionSort = 'manual';
    state.sessionManualOrder = result.order;
    saveSessionSort();
  }

  function sessionDropResult(row, event) {
    const drag = state.sessionDrag;
    if (!drag || providerSelectionFrom(state.snapshot).selected.id !== drag.providerId) return null;
    const bounds = row.getBoundingClientRect();
    const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    const targetId = row.dataset.sessionId;
    if (drag.hoveredId !== targetId || drag.placement !== placement) {
      drag.hoveredId = targetId;
      drag.placement = placement;
      drag.result = moveSessionGroup(drag.rows, drag.sourceId, targetId, placement);
      clearSessionDropMarker();
      if (drag.result) {
        const targetRow = [...$('sessionList').querySelectorAll('[data-session-id]')]
          .find(candidate => candidate.dataset.sessionId === drag.result.targetId);
        targetRow?.classList.add(`is-drop-${placement}`);
      }
    }
    return drag.result;
  }

  function pointerSessionDropResult(event) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-session-id]');
    if (target && $('sessionList')?.contains(target)) return sessionDropResult(target, event);
    if (state.sessionDrag) {
      state.sessionDrag.hoveredId = null;
      state.sessionDrag.result = null;
    }
    clearSessionDropMarker();
    return null;
  }

  function bindSessionRowDrag(row, header, entry) {
    row.dataset.sessionDepth = String(entry.depth);
    row.style.setProperty('--session-depth', String(entry.depth));
    if (!entry.id) return;
    row.dataset.sessionId = entry.id;
    if (entry.parentId) row.dataset.sessionParentId = entry.parentId;
    const handle = textElement('button', 'session-drag-handle', '⠿');
    handle.type = 'button';
    handle.draggable = false;
    handle.style.touchAction = 'none';
    handle.disabled = state.providerSaving;
    handle.title = '拖动排序，或按 Alt + ↑ / ↓；父任务始终在子任务前';
    handle.setAttribute('aria-label', `调整顺序：${safeText(entry.session.title, entry.id)}`);
    header.prepend(handle);
    handle.addEventListener('pointerdown', event => {
      if (state.providerSaving || state.sessionDrag || event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      state.sessionDrag = {
        sourceId: entry.id,
        providerId: state.sessionSortProviderId,
        rows: state.sessionRows.slice(),
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        result: null,
      };
      handle.setPointerCapture(event.pointerId);
      if ($('sessionSort')) $('sessionSort').disabled = true;
      if ($('providerSelect')) $('providerSelect').disabled = true;
    });
    handle.addEventListener('pointermove', event => {
      const drag = state.sessionDrag;
      if (drag?.handle !== handle || drag.pointerId !== event.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
        drag.active = true;
        row.classList.add('is-dragging');
        document.body.classList.add('session-drag-active');
      }
      event.preventDefault();
      pointerSessionDropResult(event);
    });
    handle.addEventListener('pointerup', event => {
      const drag = state.sessionDrag;
      if (drag?.handle !== handle || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (drag.active) applyManualSessionOrder(pointerSessionDropResult(event));
      finishSessionDrag();
    });
    const cancelPointerDrag = event => {
      if (state.sessionDrag?.handle === handle && state.sessionDrag.pointerId === event.pointerId) finishSessionDrag();
    };
    handle.addEventListener('pointercancel', cancelPointerDrag);
    handle.addEventListener('lostpointercapture', cancelPointerDrag);
    handle.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.sessionDrag?.handle === handle) {
        event.preventDefault();
        finishSessionDrag();
        return;
      }
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || state.sessionDrag || state.providerSaving) return;
      event.preventDefault();
      const siblings = state.sessionRows.filter(candidate => candidate.parentId === entry.parentId && candidate.depth === entry.depth);
      const index = siblings.findIndex(candidate => candidate.id === entry.id);
      const up = event.key === 'ArrowUp';
      const target = siblings[index + (up ? -1 : 1)];
      if (!target) return;
      applyManualSessionOrder(moveSessionGroup(state.sessionRows, entry.id, target.id, up ? 'before' : 'after'));
      renderSessionList(state.snapshot || {});
      [...$('sessionList').querySelectorAll('[data-session-id]')]
        .find(candidate => candidate.dataset.sessionId === entry.id)?.querySelector('.session-drag-handle')?.focus();
    });
  }

  function appendSessionChart(row, entry, snapshot) {
    const chart = createSessionChart(snapshot.sessionCharts?.[entry.id], {
      id: entry.id, preferenceKey: `${providerSelectionFrom(snapshot).selected.id}:${entry.id}`,
      formatPercent: formatTaskPercent, formatDuration,
    });
    if (chart) row.append(chart);
  }

  function createCodexSessionRow(entry, snapshot, index) {
    const session = entry.session;
    const row = textElement('article', `session-row${entry.depth ? ' session-row-child' : ''}`, '');
    row.setAttribute('role', 'listitem');
    const header = textElement('div', 'session-row-header', '');
    const titleBlock = textElement('div', 'session-title-block', '');
    const titleValue = safeText(session.title, `未命名${entry.depth ? '子' : ''}会话 ${index + 1}`);
    const title = textElement('h3', 'session-title', titleValue);
    title.title = titleValue;
    const idElement = textElement('span', 'session-id', entry.id || '—');
    idElement.title = idElement.textContent;
    titleBlock.append(title, idElement);
    header.append(titleBlock, textElement('span', `status-chip ${statusClass(session.status)}`, statusLabel(session.status)));
    bindSessionRowDrag(row, header, entry);
    row.append(header);
    const meta = textElement('div', 'session-meta', '');
    const model = textElement('span', 'meta-item meta-title', safeText(session.model, '—'));
    model.title = model.textContent;
    meta.append(model, textElement('span', 'meta-separator', '·'), textElement('span', 'meta-item', safeText(session.reasoningEffort, '—')));
    const childCount = finiteNumber(session.childCount);
    if (childCount > 0) meta.append(textElement('span', 'meta-separator', '·'), textElement('span', 'meta-item', `子会话 ${Math.round(childCount)} 个`));
    row.append(meta);
    const metrics = sessionTotals(session);
    row.append(textElement('div', 'session-stat-line', `总消耗额度${formatTaskPercent(metrics.totalEstimatedPercent)}，平均每1%耗时${formatDuration(metrics.averageSecondsPerPercent, '待估算')}`));
    appendSessionChart(row, entry, snapshot);
    return row;
  }

  function renderSessionPagination(filteredCount, totalCount, noun = '根会话') {
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
    if (pageInfo) pageInfo.textContent = filteredCount === 0 ? `无匹配${noun === '根会话' ? '会话' : noun}` : `第 ${state.sessionPage + 1} / ${pages} 页 · 每页 ${pageSize}`;
    setText('sessionFilterSummary', filteredCount === totalCount ? `共 ${totalCount} 个${noun}` : `匹配 ${filteredCount} / ${totalCount} 个${noun}`, '显示全部会话');
  }

  function renderSessionList(snapshot) {
    // Keep the captured handle attached while polling continues during a drag.
    if (state.sessionDrag) return;
    syncSessionSort(snapshot);
    if (isApiProvider(snapshot)) {
      renderApiSessionList(snapshot);
      return;
    }
    const list = $('sessionList');
    if (!list) return;
    list.replaceChildren();
    const sessions = sessionsFrom(snapshot);
    const searchInput = $('sessionSearch');
    if (searchInput && searchInput.value !== state.sessionQuery && document.activeElement !== searchInput) searchInput.value = state.sessionQuery;
    setText('sessionSummaryText', summaryStatus(snapshot), '等待会话样本');
    const settings = getSettings(snapshot);
    setText('sessionRefreshHint', `全部已知任务 · 每 ${settings.pollSeconds} 秒更新`, '全部已知任务 · 每 5 秒更新');
    const ordered = sortedSessionRows(sessions || [], 'codex');
    if (!sessions || sessions.length === 0) {
      list.append(textElement('div', 'empty-state', sessions ? '当前没有可显示会话' : '等待本地会话快照'));
      renderSessionPagination(0, 0);
      return;
    }
    const tokens = sessionQueryTokens(state.sessionQuery);
    const groups = groupSessionRows(ordered);
    const allById = new Map(groups.map(group => [group.root.rootId, group]));
    const filtered = groupSessionRows(tokens.length ? filterSessionRows(ordered, session => sessionMatches(session, tokens)) : ordered);
    renderSessionPagination(filtered.length, groups.length);
    if (!filtered.length) {
      list.append(textElement('div', 'empty-state', '没有匹配的会话 · 可清除搜索条件'));
      return;
    }
    const start = state.sessionPage * state.sessionPageSize;
    filtered.slice(start, start + state.sessionPageSize).forEach((group, index) => {
      const row = createCodexSessionRow(group.root, snapshot, start + index);
      const children = allById.get(group.root.rootId).children;
      if (children.length) {
        const key = group.root.id || group.root.rootId;
        const matchingChildren = tokens.length ? children.filter(child => sessionMatches(child.session, tokens)) : [];
        const childSearchMatch = matchingChildren.length > 0;
        const restrictToMatches = childSearchMatch && !sessionMatches(group.root.session, tokens);
        const expanded = state.expandedSessionIds.has(key) || (childSearchMatch && !state.sessionAutoCollapsedIds.has(key));
        const toggle = textElement('button', 'session-child-toggle button button-small button-quiet', expanded
          ? (restrictToMatches ? '收起匹配子会话' : '收起子会话')
          : (matchingChildren.length ? `显示匹配子会话（${matchingChildren.length}）` : `展开子会话（${children.length}）`));
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
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
        if (expanded) {
          const childList = textElement('div', 'session-child-list', '');
          childList.setAttribute('role', 'list');
          group.children.forEach((child, childIndex) => childList.append(createCodexSessionRow(child, snapshot, childIndex)));
          row.append(childList);
        }
      }
      list.append(row);
    });
  }

  function renderApiSessionList(snapshot) {
    const list = $('sessionList');
    if (!list) return;
    list.replaceChildren();
    const sessions = apiSessionsFrom(snapshot);
    const provider = providerSelectionFrom(snapshot).selected;
    const search = $('sessionSearch');
    if (search && document.activeElement !== search) search.value = state.sessionQuery;
    setText('sessionSummaryText', summaryStatus(snapshot));
    setText('sessionRefreshHint', `已知任务记录 · 每 ${getSettings(snapshot).pollSeconds} 秒更新`);
    const ordered = sortedSessionRows(sessions || [], provider.kind);
    if (!sessions || !sessions.length) {
      list.append(textElement('div', 'empty-state', sessions
        ? `尚无 ${provider.name} 的可读任务用量记录`
        : `等待 ${provider.name} 的本地任务快照`));
      renderSessionPagination(0, 0, '任务组');
      return;
    }
    const query = sessionQueryTokens(state.sessionQuery);
    const groups = groupSessionRows(ordered);
    const filtered = groupSessionRows(query.length ? filterSessionRows(ordered, session => sessionMatches(session, query)) : ordered);
    renderSessionPagination(filtered.length, groups.length, '任务组');
    if (!filtered.length) {
      list.append(textElement('div', 'empty-state', '没有匹配的任务 · 可清除搜索条件'));
      return;
    }
    const start = state.sessionPage * state.sessionPageSize;
    const pageRows = filtered.slice(start, start + state.sessionPageSize).flatMap(group => [group.root, ...group.children]);
    pageRows.forEach((entry, index) => {
      const session = entry.session;
      const row = textElement('article', `session-row api-task-row${entry.depth ? ' session-row-child' : ''}`, '');
      row.setAttribute('role', 'listitem');
      const header = textElement('div', 'session-row-header', '');
      const titleBlock = textElement('div', 'session-title-block', '');
      const title = textElement('h3', 'session-title', safeText(session.title, `未命名任务 ${start + index + 1}`));
      title.title = title.textContent;
      const id = textElement('span', 'session-id', session.id);
      id.title = id.textContent;
      titleBlock.append(title, id);
      header.append(titleBlock, textElement('span', `status-chip ${statusClass(session.status)}`, statusLabel(session.status)));
      bindSessionRowDrag(row, header, entry);
      row.append(header);

      const meta = textElement('div', 'session-meta', '');
      const model = textElement('span', 'meta-item meta-title', safeText(session.model, '模型未记录'));
      model.title = model.textContent;
      meta.append(model);
      const effort = safeText(session.reasoningEffort, '');
      if (effort) meta.append(textElement('span', 'meta-separator', '·'), textElement('span', 'meta-item', effort));
      row.append(meta);

      const metrics = textElement('dl', 'api-task-metrics', '');
      [
        ['已记录总输入 token', 'inputTokens'],
        ['已记录缓存输入 token', 'cachedInputTokens'],
        ['已记录输出 token', 'outputTokens'],
        ['已记录合计 token', 'totalTokens'],
      ].forEach(([label, key]) => {
        const metric = textElement('div', 'api-task-metric', '');
        metric.append(textElement('dt', '', label), textElement('dd', '', formatApiTokenCount(session, key)));
        metrics.append(metric);
      });
      row.append(metrics);
      if (finiteNumber(session.unclassifiedTokens) > 0) {
        row.append(textElement('p', 'api-task-unclassified', `未分类 token：${formatTokenCount(session.unclassifiedTokens)}，已计入合计，未列入输入/输出拆分。`));
      }
      const hasUsage = hasRecordedApiUsage(session);
      const durationLabel = session.durationScope === 'full-turn' ? '任务运行耗时' : '已知运行耗时';
      const details = [
        `${durationLabel} ${hasUsage ? formatDuration(session.totalElapsedSeconds, '未记录') : '—'}`,
        hasUsage ? `已记录 ${formatTokenCount(session.turnCount)} 轮` : '轮次未记录',
      ];
      if (parseDate(session.startedAt)) details.push(`开始 ${formatDate(session.startedAt)}`);
      if (parseDate(session.completedAt)) details.push(`结束 ${formatDate(session.completedAt)}`);
      row.append(textElement('p', 'api-task-detail', details.join(' · ')));
      if (!hasUsage || session.partial === true) row.append(textElement('p', 'session-scope-note api-task-partial', hasUsage
        ? '记录不完整，以上用量为已知下限。'
        : '尚无可读用量记录；“—”不代表零消耗。'));
      appendSessionChart(row, entry, snapshot);
      list.append(row);
    });
  }

  function renderAttribution(snapshot) {
    renderAttributionScopes(snapshot);
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

  function renderTrend(snapshot) {
    renderQuotaTrend(snapshot);
  }

  function formatTokenCount(value) {
    const parsed = finiteNumber(value);
    if (parsed === null) return '—';
    try {
      return Math.round(parsed).toLocaleString('en-US');
    } catch (_error) {
      return String(Math.round(parsed));
    }
  }

  function safeHttpUrl(value) {
    const candidate = safeText(value, '');
    if (!candidate) return null;
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch (_error) {
      return null;
    }
  }

  function comparisonRangeText(recorded) {
    const since = parseDate(recorded?.since);
    const until = parseDate(recorded?.until);
    if (!since && !until) return '统计窗口待定';
    return `记录窗口 ${formatDate(since, '开始待定')} → ${formatDate(until, '现在')}`;
  }

  function comparisonValue(value, formatter = formatCredits) {
    return value === null || value === undefined ? '—' : formatter(value);
  }

  function renderUsageComparison(snapshot) {
    const comparison = isRecord(snapshot) && isRecord(snapshot.usageComparison)
      ? snapshot.usageComparison : {};
    const recorded = isRecord(comparison.recorded) ? comparison.recorded : {};
    const pricing = isRecord(comparison.pricing) ? comparison.pricing : {};
    const validation = isRecord(comparison.validation) ? comparison.validation : {};
    const calibration = isRecord(validation.calibration) ? validation.calibration : {};
    const evaluation = isRecord(validation.evaluation) ? validation.evaluation : {};
    const status = safeText(validation.status, 'insufficient-independent-samples');
    const ready = status === 'ready';
    setText('usageComparisonStatus', ready ? '独立核对可用' : '独立样本不足', '等待数据');
    setText('usageComparisonExplanation', safeText(comparison.explanation,
      '按监控窗口内完整轮次记录汇总 credits；这不是订阅百分比或官方逐任务账单。'),
    '按监控窗口内完整轮次记录汇总 credits；这不是订阅百分比或官方逐任务账单。');
    setText('usageComparisonCredits', comparisonValue(recorded.credits));
    setText('usageComparisonTurns', comparisonValue(recorded.turnCount, formatTokenCount));
    setText('usageComparisonInputTokens', comparisonValue(recorded.inputTokens, formatTokenCount));
    setText('usageComparisonCachedInputTokens', comparisonValue(recorded.cachedInputTokens, formatTokenCount));
    setText('usageComparisonOutputTokens', comparisonValue(recorded.outputTokens, formatTokenCount));

    setText('usageComparisonValidationStatus', ready
      ? `校准 ${formatTokenCount(calibration.sampleCount)} 个 · 核对 ${formatTokenCount(evaluation.sampleCount)} 个`
      : '等待至少两个不同时间点的独立样本', '等待至少两个独立时段');
    setText('usageComparisonActualPercent', ready
      ? formatPercent(evaluation.actualPercent) : '待样本');
    setText('usageComparisonExpectedPercent', ready
      ? formatPercent(evaluation.expectedPercent) : '待样本');
    setText('usageComparisonDifferencePercent', ready
      ? `${evaluation.differencePercent > 0 ? '+' : ''}${formatCredits(evaluation.differencePercent)} 个百分点` : '待样本');
    setText('usageComparisonRelativeErrorPercent', ready
      ? formatPercent(evaluation.relativeErrorPercent) : '待样本');
    setText('usageComparisonCalibrationScope', ready
      ? `校准样本：${comparisonRangeText(calibration)} · ${formatCredits(calibration.credits)} credits / ${formatPercent(calibration.actualPercent)}` : '', '');
    setText('usageComparisonEvaluationScope', ready
      ? `核对样本：${comparisonRangeText(evaluation)} · ${formatCredits(evaluation.credits)} credits；已排除 ${formatTokenCount(validation.excludedSampleCount)} 个不适用样本。` : '', '');

    const pricingMeta = [
      safeText(pricing.unit, 'credits'),
      pricing.checkedAt ? `核对 ${safeText(pricing.checkedAt)}` : '',
      safeText(pricing.formula, ''),
    ].filter(Boolean).join(' · ');
    setText('usageComparisonPricingMeta', pricingMeta || '官方定价来源待定', '官方定价来源待定');
    const pricingLink = $('usageComparisonPricingLink');
    const pricingUrl = safeHttpUrl(pricing.source);
    if (pricingLink) {
      if (pricingUrl) {
        pricingLink.href = pricingUrl;
        pricingLink.hidden = false;
      } else {
        pricingLink.removeAttribute('href');
        pricingLink.hidden = true;
      }
    }
    const excludedTurns = finiteNumber(recorded.excludedTurnCount);
    const partialTurns = finiteNumber(recorded.partialTurnCount);
    const coverageNote = excludedTurns !== null
      ? ` · 未计入的已知轮次 ${formatTokenCount(excludedTurns)}${partialTurns !== null ? `（其中部分记录 ${formatTokenCount(partialTurns)}）` : ''}`
      : '';
    setText('usageComparisonWindow', `${comparisonRangeText(recorded)}${coverageNote}`, '统计窗口待定');
    const rows = $('usageComparisonRows');
    if (!rows) return;
    const expanded = new Set([...rows.querySelectorAll('details[open]')]
      .map(row => row.dataset.usageKey));
    rows.replaceChildren();
    const modelRows = Array.isArray(recorded.modelRows)
      ? recorded.modelRows.filter((row) => isRecord(row)) : [];
    if (!modelRows.length) {
      rows.append(textElement('div', 'empty-state usage-comparison-empty', '暂无完整轮次明细'));
      return;
    }
    modelRows.forEach((row) => {
      const details = document.createElement('details');
      details.className = 'usage-comparison-row';
      const summary = document.createElement('summary');
      const model = safeText(row.model, '模型未提供');
      const effort = safeText(row.reasoningEffort, 'effort 未提供');
      const tier = safeText(row.serviceTier, 'service tier 未提供');
      details.dataset.usageKey = JSON.stringify([model, effort, tier]);
      details.open = expanded.has(details.dataset.usageKey);
      summary.textContent = `${model} · ${effort} · ${tier}`;
      details.append(summary);
      const values = document.createElement('div');
      values.className = 'usage-comparison-row-values';
      const fields = [
        ['总输入 token', row.inputTokens, formatTokenCount],
        ['缓存输入（总输入子集）', row.cachedInputTokens, formatTokenCount],
        ['输出 token', row.outputTokens, formatTokenCount],
        ['credits', row.credits, formatCredits],
        ['完整轮次', row.turnCount, formatTokenCount],
      ];
      fields.forEach(([label, value, formatter]) => {
        const item = document.createElement('div');
        item.append(textElement('span', '', label));
        item.append(textElement('strong', '', comparisonValue(value, formatter)));
        values.append(item);
      });
      details.append(values);
      rows.append(details);
    });
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
    const methods = {
      'turn-average': { label: '本机轮次均值', className: 'method-turn-average' },
      'recent-local': { label: '本机近况', className: 'method-recent-local' },
      'same-model-reference': { label: '外部参考（不代表额度速率）', className: 'method-same-model-reference' },
      'reference-only': { label: '缺少额度样本', className: 'method-reference-only' },
    };
    const methodFor = (row) => methods[row.calculationKind] ||
      methods[row.sourceKind === 'local-average' ? 'turn-average'
        : ['local-calibrated', 'local-only'].includes(row.sourceKind) ? 'recent-local'
          : 'reference-only'];
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
        list.append(textElement('div', 'empty-state model-overview-empty', '暂无模型观测或外部参考数据'));
      } else {
        const sourceGroups = new Map();
        activeGroup.rows.forEach((row) => {
          const effort = safeText(row.effort || row.reasoningEffort, '—');
          const kind = safeText(row.sourceKind, '').toLowerCase();
          const sourceLabel = safeText(row.sourceLabel, '来源待定');
          const basis = safeText(row.rateBasis, '');
          let phrase = sourceLabel;
          if (!phrase || phrase === '来源待定') phrase = kind.includes('radar') || kind.includes('reference') ? '外部参考（不代表额度速率）' : kind.includes('local') || kind.includes('observ') ? '本机观测估算' : '来源待定';
          if (basis && basis !== phrase) phrase = `${phrase}（${basis}）`;
          const key = phrase;
          const record = sourceGroups.get(key) || { phrase, efforts: [], method: methodFor(row) };
          record.efforts.push(effort);
          sourceGroups.set(key, record);
        });
        const basisElement = $('modelOverviewBasis');
        if (basisElement) {
          basisElement.replaceChildren();
          if (sourceGroups.size === 0) {
            basisElement.append(textElement('p', '', '来源说明等待数据。'));
          } else {
            sourceGroups.forEach((record) => basisElement.append(textElement('p', `model-overview-basis-group ${record.method.className}`, `${record.efforts.join('/')}：${record.phrase}`)));
          }
        }
        activeGroup.rows.forEach((row) => {
          const item = document.createElement('article');
          const method = methodFor(row);
          item.className = `model-overview-row ${method.className}`;
          item.setAttribute('role', 'listitem');
          const effort = safeText(row.effort || row.reasoningEffort, '—');
          const header = document.createElement('div');
          header.className = 'model-overview-header';
          header.append(textElement('span', 'effort-chip', effort));
          header.append(textElement('span', 'calculation-badge', method.label));
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
          if (finiteNumber(row.sampleCount) > 0) {
            item.append(textElement('p', 'small-note',
              `${row.sampleCount === 1 ? '仅 1 个样本' : `${row.sampleCount} 个样本`} · 已记录执行 ${formatDuration(row.observationSeconds, '时长待定')}`));
          }
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
    setText('modelOverviewReference', `API参考成本仅作外部参考。${overview.referenceUpdatedAt ? ` 外部数据更新于 ${formatDate(overview.referenceUpdatedAt)}` : ''}`, '— 表示无可用样本');
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
    state.resetDeadline = resetDeadline(reset, snapshot.now);
    const resetSeconds = state.resetDeadline === null ? null : (state.resetDeadline - Date.now()) / 1000;
    state.resetScheduledAt = reset.scheduledAt;
    const officialStat = $('officialResetStat');
    if (officialStat) officialStat.classList.toggle('reset-stat-stale', stale);
    const resetLabel = state.mode === 'demo'
      ? '当前账户的窗口重置（演示）'
      : stale
        ? '当前账户的窗口重置（样本已过期）'
        : '当前账户的窗口重置';
    setText('officialResetLabel', resetLabel, '当前账户的窗口重置');
    setText('exhaustionLabel', state.mode === 'demo' ? '近24小时耗尽估计（演示）' : '额度耗尽估计（近24小时）', '本机速率耗尽估计');
    setText('officialResetCountdown', stale ? '官方数据暂不可用' : resetSeconds === null ? '等待数据' : formatResetCountdown(resetSeconds), '等待数据');
    const resetSource = safeText(reset.source, 'account/rateLimits/read');
    const resetTimezone = safeText(reset.timezone, 'Asia/Shanghai');
    const timezoneSuffix = resetTimezone === 'Asia/Shanghai' ? '' : ` · 时区 ${resetTimezone}`;
    const resetTime = reset.scheduledAt
      ? formatBeijingDateTime(reset.scheduledAt)
      : stale && reset.lastKnownScheduledAt
        ? `上次已知 ${formatBeijingDateTime(reset.lastKnownScheduledAt)}`
        : '官方时间待定';
    setText('officialResetAt', `${resetTime} · ${resetSource}${timezoneSuffix}${stale ? ' · 样本已过期' : ''}`, '官方时间待定');
    const sampleDate = parseDate(reset.observedAt);
    const sampleClock = sampleDate ? new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(sampleDate) : null;
    setText('officialResetUpdated', sampleClock
      ? `官方读取于 ${sampleClock} · 每${getSettings(snapshot).quotaPollSeconds}秒更新${stale ? ' · 样本已过期' : ''}`
      : '等待官方额度样本');
    const burn = isRecord(reset.exhaustionBasis) ? reset.exhaustionBasis : null;
    const burnRate = finiteNumber(burn?.percentPerHour);
    setText('exhaustionBasis', burn && burnRate !== null
      ? `近24小时已观察 ${formatTaskPercent(burn.observedPercent)}，有效 ${formatDuration(burn.coverageSeconds)}；均速 ${burnRate.toFixed(2)}%/时`
      : '等待有效的近24小时消耗样本');
    const exhaustionDate = stale ? null : parseDate(reset.exhaustionAt);
    state.exhaustionAt = reset.exhaustionAt;
    setText('exhaustionEstimate', exhaustionDate ? formatShortDuration((exhaustionDate.getTime() - Date.now()) / 1000, '已到期') : '等待速率样本', '等待速率样本');
    setText('exhaustionAt', exhaustionDate ? formatDate(exhaustionDate) : '近24小时记录尚不足以估计', '近24小时记录尚不足以估计');
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
    const retention = $('retentionHoursInput');
    const paused = $('pausedCheckbox');
    if (poll && document.activeElement !== poll) poll.value = String(settings.pollSeconds);
    if (retention && document.activeElement !== retention) retention.value = String(settings.retentionHours);
    if (paused && document.activeElement !== paused) paused.checked = settings.paused;
    const reminder = $('restoreDisclaimerBtn');
    if (reminder) reminder.disabled = state.reminderSaving;
    if (!state.settingsSaving) setText('settingsSaveStatus', '设置已同步', '设置已同步');
  }

  function renderCountdowns() {
    if (isApiProvider(state.snapshot)) return;
    if (Number.isFinite(state.resetDeadline)) {
      const remaining = (state.resetDeadline - Date.now()) / 1000;
      setText('officialResetCountdown', formatResetCountdown(remaining), '等待数据');
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
    renderProviderSelection(safeSnapshot);
    renderMode(snapshot);
    renderOfflineState();
    renderConnection(snapshot);
    renderGlobalError(safeSnapshot);
    renderSessionList(safeSnapshot);
    if (isApiProvider(safeSnapshot)) {
      renderApiOverview(safeSnapshot);
      state.resetDeadline = null;
      state.resetScheduledAt = null;
      state.exhaustionAt = null;
    } else {
      renderOverview(safeSnapshot);
      renderAccountWindows(safeSnapshot);
      renderAttribution(safeSnapshot);
      renderTrend(safeSnapshot);
      renderUsageComparison(safeSnapshot);
      renderRecommendation(safeSnapshot);
      renderReset(safeSnapshot);
      renderResetRadar(safeSnapshot);
    }
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

  function fetchSnapshot() {
    if (state.fetchPromise) return state.fetchPromise;
    state.fetchPromise = loadSnapshot().finally(() => { state.fetchPromise = null; });
    return state.fetchPromise;
  }

  async function loadSnapshot() {
    state.fetching = true;
    const providerVersion = state.providerChangeVersion;
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
      if (providerVersion !== state.providerChangeVersion) return;
      state.snapshot = payload;
      state.error = null;
      state.offline = false;
      state.lastUpdatedAt = Date.now();
    } catch (error) {
      if (providerVersion !== state.providerChangeVersion) return;
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
      if (Object.hasOwn(patch, 'selectedProvider')) state.providerChangeVersion += 1;
      if (isRecord(payload) && ['version', 'sessions', 'account', 'providerSelection', 'apiUsage'].some((key) => Object.hasOwn(payload, key))) {
        state.snapshot = payload;
      } else if (isRecord(payload) && isRecord(payload.settings)) {
        mergeSettingsIntoSnapshot(payload.settings);
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

  async function selectProvider(providerId) {
    const selection = providerSelectionFrom(state.snapshot);
    if (state.providerSaving || state.offline || !selection.available || providerId === selection.selected.id) return;
    if (!selection.providers.some((provider) => provider.id === providerId)) return;
    state.providerSaving = true;
    state.pendingProviderId = providerId;
    state.providerError = null;
    state.providerChangeVersion += 1;
    render(state.snapshot || {});
    try {
      const saved = await queueSettingsPatch({ selectedProvider: providerId });
      if (!saved) {
        state.providerError = `切换失败：${safeError(state.lastSettingsError, '设置未保存')}`;
        return;
      }
      if (providerSelectionFrom(state.snapshot).selected.id !== providerId) {
        // Settings-only responses require a fresh snapshot after any older poll has finished.
        if (state.fetchPromise) await state.fetchPromise;
        await fetchSnapshot();
      }
      if (!state.offline && providerSelectionFrom(state.snapshot).selected.id !== providerId) {
        state.providerError = '选择已保存，等待服务更新监控视图。';
      }
    } finally {
      state.providerSaving = false;
      state.pendingProviderId = null;
      render(state.snapshot || {});
    }
  }

  async function restoreDefaults() {
    if (state.restoreSaving || state.mode !== 'live' || state.offline || isApiProvider(state.snapshot) || state.providerSaving) return;
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
      if (button) button.disabled = state.mode !== 'live' || state.offline || isApiProvider(state.snapshot) || state.providerSaving;
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
    const provider = $('providerSelect');
    if (provider) provider.addEventListener('change', () => selectProvider(provider.value));

    const poll = $('pollSecondsInput');
    if (poll) poll.addEventListener('change', () => queueSettingsPatch({ pollSeconds: readIntegerInput('pollSecondsInput', 5, 3600, 5) }));
    const retention = $('retentionHoursInput');
    if (retention) retention.addEventListener('change', () => queueSettingsPatch({ retentionHours: readIntegerInput('retentionHoursInput', 1, 168, 24) }));
    const paused = $('pausedCheckbox');
    if (paused) paused.addEventListener('change', () => queueSettingsPatch({ paused: paused.checked }));
    const objective = $('objectiveSelect');
    if (objective) objective.addEventListener('change', () => {
      if (isApiProvider(state.snapshot) || state.providerSaving || state.mode !== 'live' || state.offline) return;
      const value = OBJECTIVES.has(objective.value) ? objective.value : 'balanced';
      objective.value = value;
      queueSettingsPatch({ objective: value });
    });
    const autoSwitch = $('autoSwitchCheckbox');
    if (autoSwitch) autoSwitch.addEventListener('change', () => {
      if (isApiProvider(state.snapshot) || state.providerSaving || state.mode !== 'live' || state.offline) return;
      queueSettingsPatch({ autoSwitch: autoSwitch.checked });
    });
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

    const sessionSort = $('sessionSort');
    if (sessionSort) sessionSort.addEventListener('change', () => {
      if (state.sessionDrag || state.providerSaving) return;
      state.sessionSort = sessionSortPreference({ sort: sessionSort.value }).sort;
      if (state.sessionSort === 'manual' && !state.sessionManualOrder.length) {
        state.sessionManualOrder = state.sessionRows.map(row => row.id).filter(Boolean);
      }
      state.sessionPage = 0;
      saveSessionSort();
      renderSessionList(state.snapshot || {});
    });
    window.addEventListener('blur', finishSessionDrag);

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
        if (state.snapshot && !isApiProvider(state.snapshot)) renderTrend(state.snapshot);
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
