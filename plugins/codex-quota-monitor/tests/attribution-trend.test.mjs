import test from "node:test";
import assert from "node:assert/strict";
import { buildAttributionHistory, buildAttributionTrend } from "../server/attribution-trend.mjs";

const start = 1_800_000_000_000;
const minute = 60_000;

function official(id, at, percent, estimated, unattributed, extra = {}) {
  return {
    id,
    at,
    percent,
    attributedPercent: estimated,
    unattributedPercent: unattributed,
    coverage: "official-quota-sample",
    ...extra,
  };
}

test("builds cumulative three-series consumption across a quota reset", () => {
  const result = buildAttributionTrend([
    official("before-reset", start + minute, 3, 2, 1, { quotaIdentity: "old" }),
    official("after-reset", start + 2 * minute, 4, 4, 0, { quotaIdentity: "new" }),
  ], { since: start, through: start + 3 * minute, windowLabel: "周额度" });

  assert.equal(result.since, start);
  assert.equal(result.through, start + 3 * minute);
  assert.equal(result.windowLabel, "周额度");
  assert.deepEqual(result.history, [
    { at: start + minute, observedPercent: 3, estimatedPercent: 2, unattributedPercent: 1, segment: 0 },
    { at: start + 2 * minute, observedPercent: 7, estimatedPercent: 6, unattributedPercent: 1, segment: 0 },
  ]);
  assert.equal(result.observedPercent, 7);
  assert.equal(result.estimatedPercent, 6);
  assert.equal(result.unattributedPercent, 1);
  assert.equal(result.hasBoundary, false);
});

test("a corrupt official split breaks the segment without counting its amount", () => {
  const result = buildAttributionTrend([
    official("first", start + minute, 1, 1, 0),
    official("corrupt", start + 2 * minute, 5, 4, 0),
    official("last", start + 3 * minute, 2, 1, 1),
  ], { since: start, through: start + 4 * minute });

  assert.deepEqual(result.history, [
    { at: start + minute, observedPercent: 1, estimatedPercent: 1, unattributedPercent: 0, segment: 0 },
    { at: start + 3 * minute, observedPercent: 3, estimatedPercent: 2, unattributedPercent: 1, segment: 1 },
  ]);
  assert.equal(result.hasBoundary, true);
});

test("clips valid intervals to the shared window and does not fabricate balance values", () => {
  const result = buildAttributionTrend([
    official("interval", start - minute, 4, 3, 1, {
      startAt: start - minute,
      endAt: start + minute,
      at: undefined,
    }),
  ], { since: start, through: start + 2 * minute });

  assert.deepEqual(result.history, [
    { at: start + minute, observedPercent: 2, estimatedPercent: 1.5, unattributedPercent: 0.5, segment: 0 },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.history[0], "remainingPercent"), false);
});

test("recovered or unlocatable records are boundaries, while later official data remains usable", () => {
  const result = buildAttributionHistory([
    {
      id: "recovered",
      at: start + minute,
      percent: 9,
      attributedPercent: 9,
      unattributedPercent: 0,
      coverage: "recovered-attributed-lower-bound",
    },
    official("later", start + 2 * minute, 2, 0, 2),
  ], { since: start, through: start + 3 * minute });

  assert.deepEqual(result.history, [
    { at: start + 2 * minute, observedPercent: 2, estimatedPercent: 0, unattributedPercent: 2, segment: 1 },
  ]);
  assert.equal(result.hasBoundary, true);
});
