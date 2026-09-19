// Build the browser-facing cumulative attribution trend from official quota
// deltas.  This module deliberately does not know about the estimator or
// persistence format: callers pass the retained rollingQuotaEvents array and
// choose the shared time window.

const DEFAULT_TOLERANCE = 1e-9;

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function eventPosition(event) {
  const startAt = finiteNumber(event?.startAt);
  const endAt = finiteNumber(event?.endAt);
  if (startAt !== null && endAt !== null && endAt > startAt) {
    return { startAt, endAt, interval: true };
  }
  // The estimator treats a point event as located by `at`, or by the one
  // available side of a malformed interval. Keep that behavior here so a
  // timestamped boundary is still represented when a field is omitted.
  const at = finiteNumber(event?.at);
  if (at !== null) return { startAt: at, endAt: at, interval: false };
  if (startAt !== null) return { startAt, endAt: startAt, interval: false };
  if (endAt !== null) return { startAt: endAt, endAt, interval: false };
  return null;
}

function completeSplit(event, tolerance = DEFAULT_TOLERANCE) {
  if (event?.coverage !== "official-quota-sample") return false;
  const percent = finiteNumber(event?.percent);
  const estimated = finiteNumber(event?.attributedPercent);
  const unattributed = finiteNumber(event?.unattributedPercent);
  if (percent === null || percent <= 0 || estimated === null || estimated < 0 ||
      unattributed === null || unattributed < 0) return false;
  const difference = estimated + unattributed - percent;
  return Math.abs(difference) <= tolerance * Math.max(1, Math.abs(percent));
}

function withinWindow(position, since, through) {
  if (!position) return true;
  return position.endAt >= since && position.startAt <= through;
}

function sliceEvent(event, position, since, through) {
  if (!position || !withinWindow(position, since, through)) return null;
  const percent = finiteNumber(event.percent);
  const estimated = finiteNumber(event.attributedPercent);
  const unattributed = finiteNumber(event.unattributedPercent);
  if (percent === null || estimated === null || unattributed === null) return null;
  if (!position.interval) {
    return {
      at: position.startAt,
      percent,
      estimated,
      unattributed,
      startAt: position.startAt,
      endAt: position.endAt,
    };
  }
  const startAt = Math.max(position.startAt, since);
  const endAt = Math.min(position.endAt, through);
  if (!(endAt > startAt)) return null;
  const fraction = (endAt - startAt) / (position.endAt - position.startAt);
  return {
    at: endAt,
    percent: percent * fraction,
    estimated: estimated * fraction,
    unattributed: unattributed * fraction,
    startAt,
    endAt,
  };
}

function boundaryPosition(record, since, through) {
  if (!record.position) return null;
  return withinWindow(record.position, since, through) ? record.position : null;
}

function normalizeOptions(options = {}, events = []) {
  const candidateThrough = finiteNumber(options.through ?? options.now);
  const through = candidateThrough === null ? Date.now() : candidateThrough;
  const candidateSince = finiteNumber(options.since ?? options.windowStart);
  if (candidateSince !== null) {
    return { since: Math.min(candidateSince, through), through };
  }
  const positions = events
    .map((event) => eventPosition(event))
    .filter((position) => position && position.startAt <= through);
  const since = positions.length
    ? Math.min(...positions.map((position) => position.startAt))
    : through;
  return { since, through };
}

function outputMetadata(history, options, since, through, hasBoundary) {
  const last = history.at(-1);
  return {
    history,
    since,
    through,
    windowLabel: typeof options.windowLabel === "string" && options.windowLabel.trim()
      ? options.windowLabel.trim() : null,
    observedPercent: last?.observedPercent ?? 0,
    estimatedPercent: last?.estimatedPercent ?? 0,
    unattributedPercent: last?.unattributedPercent ?? 0,
    sampleCount: history.length,
    hasBoundary,
    coverage: history.length ? "rolling" : "none",
  };
}

/**
 * Build cumulative consumption points for the three attribution categories.
 *
 * @param {Array<object>} rollingQuotaEvents retained quota events from the
 *        estimator state. Only complete `official-quota-sample` events count.
 * @param {object} [options]
 * @param {number} [options.since] shared lower bound for the chart/card window
 * @param {number} [options.through] shared upper bound (defaults to now)
 * @param {string} [options.windowLabel] copied into the result for the card
 * @returns {{history: Array<{at:number, observedPercent:number,
 *   estimatedPercent:number, unattributedPercent:number, segment:number}>,
 *   since:number, through:number, windowLabel:string|null,
 *   observedPercent:number, estimatedPercent:number, unattributedPercent:number,
 *   sampleCount:number, hasBoundary:boolean, coverage:string}}
 */
export function buildAttributionTrend(rollingQuotaEvents, options = {}) {
  const source = Array.isArray(rollingQuotaEvents)
    ? rollingQuotaEvents : [];
  const { since, through } = normalizeOptions(options, source);
  const tolerance = finiteNumber(options.tolerance) !== null && options.tolerance >= 0
    ? options.tolerance : DEFAULT_TOLERANCE;

  // Keep malformed records as boundaries. Their amounts are intentionally
  // ignored: a corrupt split must never become a plausible zero or an
  // apparent official sample on the chart.
  const records = source.map((event, index) => {
    const position = eventPosition(event);
    const inWindow = boundaryPosition({ position }, since, through) !== null || !position;
    const valid = inWindow && completeSplit(event, tolerance)
      ? sliceEvent(event, position, since, through)
      : null;
    return { event, index, position, valid, boundary: inWindow && !valid };
  }).filter((record) => record.valid || record.boundary);

  // The collector normally appends events chronologically. Sorting also makes
  // restored snapshots deterministic; malformed records with no timestamp
  // are retained as an unknown boundary and therefore seed a new segment.
  records.sort((a, b) => {
    const aAt = a.position?.endAt ?? Infinity;
    const bAt = b.position?.endAt ?? Infinity;
    return aAt - bAt || (a.position?.startAt ?? Infinity) - (b.position?.startAt ?? Infinity) ||
      a.index - b.index;
  });

  let cumulativeObserved = 0;
  let cumulativeEstimated = 0;
  let cumulativeUnattributed = 0;
  let segment = 0;
  let pendingBoundary = records.some((record) => record.boundary && !record.position);
  let boundaryAt = null;
  let hasBoundary = pendingBoundary;
  const history = [];

  for (const record of records) {
    if (record.boundary) {
      hasBoundary = true;
      pendingBoundary = true;
      if (record.position) boundaryAt = Math.max(boundaryAt ?? -Infinity, record.position.endAt);
      continue;
    }
    const point = record.valid;
    // A valid interval spanning a damaged point cannot be placed on either
    // side of that point without inventing its split. Exclude it and keep the
    // boundary open until a complete event begins after the damaged range.
    if (boundaryAt !== null && point.startAt < boundaryAt && point.endAt > boundaryAt) {
      hasBoundary = true;
      pendingBoundary = true;
      continue;
    }
    if (boundaryAt !== null && point.startAt < boundaryAt) {
      hasBoundary = true;
      pendingBoundary = true;
      continue;
    }
    if (pendingBoundary) segment += 1;
    pendingBoundary = false;
    if (boundaryAt !== null && point.startAt >= boundaryAt) boundaryAt = null;
    cumulativeObserved += point.percent;
    cumulativeEstimated += point.estimated;
    cumulativeUnattributed += point.unattributed;
    history.push({
      at: point.at,
      observedPercent: cumulativeObserved,
      estimatedPercent: cumulativeEstimated,
      unattributedPercent: cumulativeUnattributed,
      segment,
    });
  }

  return outputMetadata(history, options, since, through, hasBoundary);
}

// The snapshot field is named attributionHistory. Keep a descriptive alias so
// callers can choose the name that matches their surrounding code while both
// paths share one implementation and one contract.
export const buildAttributionHistory = buildAttributionTrend;

export default buildAttributionTrend;
