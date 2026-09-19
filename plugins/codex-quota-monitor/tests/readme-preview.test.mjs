import assert from "node:assert/strict";
import test from "node:test";

import {
  createReadmePreviewCollector,
  createReadmeSnapshot,
} from "../scripts/readme-preview.mjs";

const NOW = Date.parse("2026-09-08T12:00:00Z");

test("README preview is deterministic, synthetic, and complete for screenshot data", () => {
  const first = createReadmeSnapshot({ now: NOW });
  const second = createReadmeSnapshot({ now: NOW });
  assert.deepEqual(first, second);
  assert.equal(first.mode, "demo");
  assert.equal(first.dataSchema, 2);
  assert.equal(first.synthetic, true);
  assert.equal(first.account.summary.remainingPercent, 72.345);
  assert.equal(first.account.summary.usedPercent, 27.655);
  assert.equal(first.account.plan.type, "pro");
  assert.equal(first.account.plan.multiplier, null);
  assert.equal(first.account.stale, false);
  assert.equal(first.settings.retentionHours, 24);
  assert.equal(first.cost.llmCalls, 0);
  assert.equal(first.cost.modelCalls, 0);
  assert.equal(first.cost.localRead, 18);
  assert.equal(first.cost.remoteReads, 0);
  assert.equal(first.cost.localReadsPerHour, 720);
  assert.equal(first.history.length, 8);
  assert.ok(first.history.every((point, index, points) => index === 0 || point.at > points[index - 1].at));
  assert.ok(first.attributionHistory.length >= 3);
  assert.ok(first.attributionHistory.every((point, index, points) =>
    index === 0 || point.at > points[index - 1].at));
  const attributionEnd = first.attributionHistory.at(-1);
  assert.equal(attributionEnd.observedPercent, first.attribution.observedPercent);
  assert.equal(attributionEnd.estimatedPercent, first.attribution.estimatedPercent);
  assert.equal(attributionEnd.unattributedPercent, first.attribution.unattributedPercent);
  assert.equal(first.usageComparison.recorded.since, first.attribution.since);
  assert.equal(first.usageComparison.recorded.until, first.now);
  assert.equal(first.resetRadar.source, "https://codex-reset.com/zh/");
  assert.match(first.resetRadar.note, /合成演示/);
});

test("preview attribution and theory comparison use reconciled synthetic totals", () => {
  const snapshot = createReadmeSnapshot({ now: NOW });
  const { recorded, pricing, validation } = snapshot.usageComparison;
  const modelRows = recorded.modelRows;
  assert.ok(modelRows.length >= 2);
  assert.ok(Math.abs(modelRows.reduce((sum, row) => sum + row.credits, 0) - recorded.credits) < 1e-12);
  assert.equal(modelRows.reduce((sum, row) => sum + row.inputTokens, 0), recorded.inputTokens);
  assert.equal(modelRows.reduce((sum, row) => sum + row.cachedInputTokens, 0), recorded.cachedInputTokens);
  assert.equal(modelRows.reduce((sum, row) => sum + row.outputTokens, 0), recorded.outputTokens);
  assert.equal(modelRows.reduce((sum, row) => sum + row.turnCount, 0), recorded.turnCount);
  assert.ok(modelRows.every((row) => row.cachedInputTokens <= row.inputTokens));
  assert.equal(pricing.unit, "credits");
  assert.match(pricing.source, /^https:\/\//);
  assert.match(pricing.formula, /非缓存输入/);
  assert.equal(validation.status, "ready");
  assert.ok(validation.calibration.percentPerCredit > 0);
  assert.ok(validation.evaluation.expectedPercent > 0);
  assert.ok(Number.isFinite(validation.evaluation.relativeErrorPercent));
});

test("preview sessions have safe demo IDs, expandable children, and rate fields", () => {
  const snapshot = createReadmeSnapshot({ now: NOW });
  assert.ok(snapshot.sessions.length >= 3 && snapshot.sessions.length <= 5);
  assert.ok(snapshot.sessions.some((session) => session.status === "active"));
  assert.ok(snapshot.sessions.some((session) => session.status === "idle"));
  assert.ok(snapshot.sessions.some((session) => session.children.length > 0));
  for (const root of snapshot.sessions) {
    assert.match(root.id, /^demo-[a-z0-9-]+$/);
    assert.equal(root.parentThreadId, null);
    assert.equal(typeof root.elapsedSeconds, "number");
    assert.equal(typeof root.tokens, "number");
    assert.equal(typeof root.observationSeconds, "number");
    assert.equal(typeof root.totalElapsedSeconds, "number");
    assert.equal(typeof root.totalEstimatedPercent, "number");
    assert.equal(typeof root.latestTurnElapsedSeconds, "number");
    assert.equal(typeof root.latestTurnEstimatedPercent, "number");
    assert.ok(root.latestTurnSecondsPerPercent === null || typeof root.latestTurnSecondsPerPercent === "number");
    assert.ok(root.secondsPerPercent === null || typeof root.secondsPerPercent === "number");
    assert.ok(root.latestTurnElapsedSeconds <= root.totalElapsedSeconds);
    assert.ok(root.latestTurnEstimatedPercent <= root.totalEstimatedPercent);
    for (const child of root.children) {
      assert.match(child.id, /^demo-[a-z0-9-]+$/);
      assert.equal(child.parentThreadId, root.id);
      assert.equal(typeof child.tokens, "number");
      assert.equal(typeof child.elapsedSeconds, "number");
      assert.equal(typeof child.observationSeconds, "number");
      assert.equal(typeof child.totalElapsedSeconds, "number");
      assert.equal(typeof child.totalEstimatedPercent, "number");
      assert.equal(typeof child.latestTurnElapsedSeconds, "number");
      assert.equal(typeof child.latestTurnEstimatedPercent, "number");
      assert.ok(child.latestTurnSecondsPerPercent === null || typeof child.latestTurnSecondsPerPercent === "number");
      assert.ok(child.averageSecondsPerPercent === null || child.averageSecondsPerPercent > 0);
    }
  }
  const interfaceRoot = snapshot.sessions.find((session) => session.id === "demo-interface-refactor");
  const interfaceTests = interfaceRoot.children.find((child) => child.id === "demo-interface-tests");
  assert.equal(interfaceRoot.totalElapsedSeconds, 55 * 60);
  assert.equal(interfaceTests.totalElapsedSeconds, 41 * 60);
  assert.equal(interfaceRoot.latestTurnChildCount, 2);
  assert.equal(interfaceRoot.latestTurnElapsedSeconds, 25 * 60);
  assert.ok(interfaceRoot.latestTurnEstimatedPercent > interfaceRoot.ownLatestTurnEstimatedPercent);
  assert.ok(interfaceRoot.latestTurnEstimatedPercent < interfaceRoot.totalEstimatedPercent);
  assert.equal(interfaceRoot.observationSeconds, 1224);
  assert.ok(Math.abs(interfaceRoot.averageSecondsPerPercent * interfaceRoot.totalEstimatedPercent - 3300) < 1e-8);
  assert.ok(interfaceTests.latestTurnElapsedSeconds <= interfaceTests.totalElapsedSeconds);
  assert.ok(interfaceTests.latestTurnEstimatedPercent <= interfaceTests.totalEstimatedPercent);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|CODEX_HOME/);
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test("model overview covers current synthetic GPT families and public references", () => {
  const snapshot = createReadmeSnapshot({ now: NOW });
  const rows = snapshot.modelOverview.rows;
  const astra = new Set(rows.filter((row) => row.model === "gpt-6-astra").map((row) => row.effort));
  const luna = new Set(rows.filter((row) => row.model === "gpt-5.6-luna").map((row) => row.effort));
  for (const effort of ["ultra", "max", "xhigh", "high", "medium", "low"]) assert.ok(astra.has(effort));
  for (const effort of ["max", "xhigh", "high", "medium", "low"]) assert.ok(luna.has(effort));
  assert.ok(rows.some((row) => row.sourceKind === "local-average" && row.calculationKind === "turn-average"));
  assert.ok(rows.some((row) => row.sourceKind === "radar-reference" && row.secondsPerPercent === null));
  assert.ok(rows.every((row) => row.sourceKind !== "radar-relative"));
  assert.equal(snapshot.modelOverview.sourceUrl, "https://api.codexradar.com/api/v1/intelligence-efficiency");
  assert.match(snapshot.modelOverview.note, /订阅.*百分比/);
});

test("preview collector is an isolated read-only stub", async () => {
  const collector = createReadmePreviewCollector({ now: NOW });
  await collector.init();
  const first = collector.snapshot();
  first.sessions[0].title = "mutated locally";
  const second = collector.snapshot();
  assert.notEqual(second.sessions[0].title, "mutated locally");
  await assert.rejects(collector.update({ autoSwitch: true }), /演示预览/);
  await assert.rejects(collector.restoreDefaults(), /演示预览/);
  await collector.close();
});
