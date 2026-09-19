import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRuntimeAxis } from '../web/usage-charts.mjs';
import { buildSessionSegments } from '../server/chart-data.mjs';

const start = 1_800_000_000_000;

test('idle gaps have no width while execution widths retain their duration ratio', () => {
  const later = start + 4 * 3_600_000;
  const axis = createSessionRuntimeAxis([[later, later + 60_000], [start, start + 10_000]]);
  assert.equal(axis.durationMs, 70_000);
  assert.equal(axis.elapsedAt(start + 10_000), axis.elapsedAt(later));
  assert.equal(axis.elapsedAt(start + 60_000), 10_000);
  assert.equal(axis.elapsedAt(later + 30_000), 40_000);
  assert.equal(axis.elapsedAt(later + 60_000), 70_000);
});

test('parallel parent and child executions share running time rather than double counting', () => {
  const axis = createSessionRuntimeAxis([
    [start, start + 40_000], [start + 20_000, start + 50_000],
    [start + 10_000, start + 15_000], [start, start + 40_000],
    [start + 200_000, start + 220_000],
  ]);
  assert.equal(axis.durationMs, 70_000);
  assert.equal(axis.elapsedAt(start + 30_000), 30_000);
  assert.equal(axis.elapsedAt(start + 100_000), 50_000);
  assert.equal(axis.elapsedAt(start + 210_000), 60_000);
});

test('adjacent execution endpoints join without changing wall-clock labels or consumption', () => {
  const chart = buildSessionSegments([
    { id: 'first', startedAt: start, completedAt: start + 10_000, amount: 1 },
    { id: 'second', startedAt: start + 60_000, completedAt: start + 80_000, amount: 2 },
  ], { now: start + 80_000 });
  const original = structuredClone(chart);
  const spans = chart.segments.map(segment => [segment.points[0].at, segment.points.at(-1).at]);
  const axis = createSessionRuntimeAxis(spans);
  const end = chart.segments[0].points.at(-1), next = chart.segments[1].points[0];
  assert.equal(axis.elapsedAt(end.at), axis.elapsedAt(next.at));
  assert.equal(end.value, next.value);
  assert.equal(axis.durationMs, 30_000);
  assert.equal(chart.since, start);
  assert.equal(chart.until, start + 80_000);
  assert.equal(chart.totalAmount, 3);
  assert.deepEqual(chart, original);
});

test('zero-duration or invalid spans do not create artificial running time', () => {
  const axis = createSessionRuntimeAxis([[start, start], [start + 1000, start + 1000],
    [start, start - 1], [NaN, start], null]);
  assert.equal(axis.durationMs, 0);
  assert.equal(axis.elapsedAt(start - 1), 0);
  assert.equal(axis.elapsedAt(start + 2000), 0);
  assert.equal(axis.elapsedAt(NaN), null);
  assert.equal(createSessionRuntimeAxis([]).elapsedAt(start), 0);
});
