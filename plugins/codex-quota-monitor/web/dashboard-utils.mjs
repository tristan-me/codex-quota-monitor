// Pure formatting, ordering, and clock arithmetic shared by the browser and tests.
function finiteValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatTaskPercent(value) {
  const number = finiteValue(value);
  if (number === null) return '待估算';
  if (number === 0) return '0.00%';
  const exponent = Number(Math.abs(number).toExponential().split('e')[1]);
  const decimals = Math.max(2, Math.ceil(-exponent / 2) * 2);
  // toFixed only supports up to 100 decimals. Scientific notation also keeps
  // subnormal values visible, including Number.MIN_VALUE, without underflow.
  return `${decimals <= 100 ? number.toFixed(decimals) : number.toExponential()}%`;
}

export const SESSION_SORT_MODES = Object.freeze([
  'time-desc', 'total-desc', 'total-asc', 'speed-desc', 'speed-asc', 'manual',
]);

function identity(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function sessionSortStorageKey(providerId) {
  return `codexQuotaMonitor.sessionSort.${encodeURIComponent(identity(providerId) || 'openai')}`;
}

export function sessionSortPreference(value) {
  const sort = SESSION_SORT_MODES.includes(value?.sort) ? value.sort : 'time-desc';
  const order = Array.isArray(value?.order) ? [...new Set(value.order.filter(identity))] : [];
  return { sort, order };
}

function parentIdentity(session) {
  return identity(session.parentThreadId) || identity(session.parentId) || identity(session.parentSessionId);
}

function activityTime(session) {
  const latest = keys => {
    const times = keys.map(key => {
      const value = session[key];
      const numeric = finiteValue(value);
      if (numeric !== null) return numeric > 0 ? numeric < 100_000_000_000 ? numeric * 1000 : numeric : null;
      const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
      return Number.isFinite(timestamp) ? timestamp : null;
    }).filter(value => value !== null);
    return times.length ? Math.max(...times) : null;
  };
  return latest(['latestTurnStartedAt', 'lastCompletedAt', 'startedAt', 'completedAt'])
    ?? latest(['updatedAt', 'createdAt']);
}

function totalAmount(session, providerKind) {
  if (providerKind !== 'codex') {
    const total = finiteValue(session.totalTokens);
    if (total === 0 && Object.hasOwn(session, 'turnCount') && !(finiteValue(session.turnCount) > 0)) return null;
    return total !== null && total >= 0 ? total : null;
  }
  const value = Object.hasOwn(session, 'totalEstimatedPercent') ? session.totalEstimatedPercent
    : ['unavailable', 'projected'].includes(session.estimateStatus) ? null : session.estimatedPercent;
  const total = finiteValue(value);
  return total !== null && total >= 0 ? total : null;
}

function consumptionSpeed(session, providerKind) {
  if (providerKind !== 'codex') {
    const total = totalAmount(session, providerKind);
    const duration = finiteValue(session.totalElapsedSeconds);
    return total !== null && duration > 0 ? total / duration : null;
  }
  const seconds = ['averageSecondsPerPercent', 'latestTurnSecondsPerPercent', 'secondsPerPercent']
    .map(key => finiteValue(session[key])).find(value => value !== null && value > 0);
  return seconds > 0 ? 1 / seconds : null;
}

function compareKnown(a, b, descending = false) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a === b ? 0 : (a < b ? -1 : 1) * (descending ? -1 : 1);
}

function sessionForest(sessions) {
  const nodes = [];
  const byId = new Map();
  const seen = new Set();
  const collect = (items, enclosingId = null) => {
    for (const session of Array.isArray(items) ? items : []) {
      if (!session || typeof session !== 'object' || Array.isArray(session) || seen.has(session)) continue;
      seen.add(session);
      const id = identity(session.id);
      if (id && byId.has(id)) continue;
      const node = { session, id, parentId: parentIdentity(session) || enclosingId, children: [], index: nodes.length };
      nodes.push(node);
      if (id) byId.set(id, node);
      collect(session.children, id || enclosingId);
    }
  };
  collect(sessions);
  for (const node of nodes) node.parent = byId.get(node.parentId) || null;
  // An incomplete snapshot may contain orphaned or cyclic links. Keep every
  // task visible, break only the cycle, and never let traversal loop forever.
  const visited = new Set();
  for (const node of nodes) {
    const chain = new Set();
    let current = node;
    while (current && !visited.has(current)) {
      if (chain.has(current)) {
        current.parent = null;
        break;
      }
      chain.add(current);
      current = current.parent;
    }
    chain.forEach(member => visited.add(member));
  }
  const roots = [];
  for (const node of nodes) {
    node.parentId = node.parent?.id || null;
    (node.parent ? node.parent.children : roots).push(node);
  }
  return { nodes, roots };
}

export function orderSessionRows(sessions, { sort = 'time-desc', providerKind = 'codex', manualOrder = [] } = {}) {
  const { nodes, roots } = sessionForest(sessions);
  const preference = sessionSortPreference({ sort, order: manualOrder });
  const ranks = new Map(preference.order.map((id, index) => [id, index]));
  const valueFor = preference.sort.startsWith('total-') ? session => totalAmount(session, providerKind)
    : preference.sort.startsWith('speed-') ? session => consumptionSpeed(session, providerKind) : activityTime;
  const times = new Map();
  const groupActivity = node => {
    let latest = activityTime(node.session);
    for (const child of node.children) {
      const childTime = groupActivity(child);
      if (childTime !== null && (latest === null || childTime > latest)) latest = childTime;
    }
    times.set(node, latest);
    return latest;
  };
  roots.forEach(groupActivity);
  const values = preference.sort === 'time-desc' ? times
    : new Map(nodes.map(node => [node, valueFor(node.session)]));
  const compare = (a, b) => {
    const primary = preference.sort === 'manual'
      ? compareKnown(ranks.get(a.id) ?? null, ranks.get(b.id) ?? null)
      : compareKnown(values.get(a), values.get(b), preference.sort.endsWith('-desc'));
    return primary || compareKnown(times.get(a), times.get(b), true)
      || (a.id && b.id && a.id !== b.id ? a.id < b.id ? -1 : 1 : a.index - b.index);
  };
  const rows = [];
  const append = (siblings, depth, rootId = null) => {
    siblings.sort(compare).forEach(node => {
      const groupId = depth === 0 ? node.id ?? node.index : rootId;
      rows.push({ session: node.session, id: node.id, parentId: node.parentId, depth, rootId: groupId });
      append(node.children, depth + 1, groupId);
    });
  };
  append(roots, 0);
  return rows;
}

export function filterSessionRows(rows, matches) {
  const byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  const visible = new Set();
  let matchedDepth = null;
  for (const row of rows) {
    if (matchedDepth !== null && row.depth <= matchedDepth) matchedDepth = null;
    if (matches(row.session)) {
      if (matchedDepth === null) matchedDepth = row.depth;
      let parent = byId.get(row.parentId);
      while (parent && !visible.has(parent)) {
        visible.add(parent);
        parent = byId.get(parent.parentId);
      }
    }
    if (matchedDepth !== null) visible.add(row);
  }
  return rows.filter(row => visible.has(row));
}

export function moveSessionGroup(rows, sourceId, targetId, placement = 'before') {
  if (!['before', 'after'].includes(placement)) return null;
  const byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  const source = byId.get(sourceId);
  let target = byId.get(targetId);
  if (!source || !target || source === target) return null;
  // Dropping on a sibling's descendant moves relative to that whole sibling
  // group. A child keeps its parent; dragging cannot reparent a task.
  while (target && target.depth > source.depth) target = byId.get(target.parentId);
  if (!target || target === source || target.parentId !== source.parentId) return null;
  const subtree = row => {
    const start = rows.indexOf(row);
    let end = start + 1;
    while (end < rows.length && rows[end].depth > row.depth) end += 1;
    return rows.slice(start, end);
  };
  const moving = subtree(source);
  const targetGroup = subtree(target);
  const movingSet = new Set(moving);
  const remaining = rows.filter(row => !movingSet.has(row));
  const insertAt = placement === 'after'
    ? remaining.indexOf(targetGroup.at(-1)) + 1 : remaining.indexOf(target);
  remaining.splice(insertAt, 0, ...moving);
  return { order: remaining.map(row => row.id).filter(Boolean), targetId: target.id };
}

export function resetDeadline(reset, snapshotNow) {
  if (reset?.stale) return null;
  if (reset?.scheduledAt !== null && reset?.scheduledAt !== undefined) {
    const timestamp = typeof reset.scheduledAt === "number"
      ? reset.scheduledAt : Date.parse(reset.scheduledAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.isFinite(reset?.secondsUntil) && Number.isFinite(snapshotNow)
    ? snapshotNow + reset.secondsUntil * 1000 : null;
}
