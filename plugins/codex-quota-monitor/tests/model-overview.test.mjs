import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelOverview,
  RADAR_SOURCE_URL,
} from "../server/model-overview.mjs";

const now = Date.parse("2026-09-08T12:00:00Z");
const model = (id, efforts, extra = {}) => ({
  model: id,
  displayName: id.toUpperCase(),
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
  })),
  ...extra,
});

function row(overview, modelId, effort) {
  const found = overview.rows.find(
    (item) => item.model === modelId && item.effort === effort,
  );
  assert.ok(found, `missing ${modelId}/${effort}`);
  return found;
}

test("Radar reference exposes cost/hour but does not fabricate subscription speed", () => {
  const overview = buildModelOverview({
    models: [model("gpt-6-astra", ["medium"])],
    sessions: [],
    state: {},
    now,
  });
  const astra = row(overview, "gpt-6-astra", "medium");
  assert.equal(overview.sourceUrl, RADAR_SOURCE_URL);
  assert.equal(astra.available, true);
  assert.equal(astra.sourceKind, "radar-reference");
  assert.equal(astra.secondsPerPercent, null);
  assert.equal(astra.quotaPercentPerHour, null);
  assert.ok(
    Math.abs(astra.referenceCostPerHour - (2.206416 * 60) / 8.89) < 1e-12,
  );
  assert.match(astra.rateBasis, /不能直接换算/);
});

test("own root metrics and flat children are attributed once per model/effort", () => {
  const overview = buildModelOverview({
    models: [
      model("gpt-5.6-terra", ["medium"]),
      model("gpt-5.6-luna", ["high"]),
    ],
    sessions: [
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        ownSecondsPerPercent: 120,
        ownAverageSecondsPerPercent: 180,
        ownObservationSeconds: 600,
        ownStatus: "idle",
        secondsPerPercent: 999,
        children: [
          {
            model: "gpt-5.6-luna",
            reasoningEffort: "high",
            status: "active",
            secondsPerPercent: 60,
            observationSeconds: 300,
          },
        ],
      },
    ],
    state: {},
    now,
  });
  const terra = row(overview, "gpt-5.6-terra", "medium");
  const luna = row(overview, "gpt-5.6-luna", "high");
  assert.equal(terra.sourceKind, "local-calibrated");
  assert.equal(terra.secondsPerPercent, 120);
  assert.equal(terra.quotaPercentPerHour, 30);
  assert.equal(luna.sourceKind, "local-calibrated");
  assert.equal(luna.secondsPerPercent, 60);
  assert.equal(luna.quotaPercentPerHour, 60);
});

test("average local anchor yields an explicit Radar-relative estimate", () => {
  const overview = buildModelOverview({
    models: [
      model("gpt-5.6-terra", ["medium"]),
      model("gpt-5.6-luna", ["medium"]),
    ],
    sessions: [
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        averageSecondsPerPercent: 100,
        observationSeconds: 100,
      },
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        averageSecondsPerPercent: 200,
        observationSeconds: 300,
      },
    ],
    state: {},
    now,
  });
  const terra = row(overview, "gpt-5.6-terra", "medium");
  const luna = row(overview, "gpt-5.6-luna", "medium");
  assert.equal(terra.sourceKind, "local-average");
  assert.equal(terra.secondsPerPercent, 160);
  assert.ok(Math.abs(terra.quotaPercentPerHour - 3600 / 160) < 1e-12);
  assert.equal(luna.sourceKind, "radar-relative");
  assert.ok(luna.secondsPerPercent > 0);
  assert.ok(luna.quotaPercentPerHour > 0);
  assert.match(luna.rateBasis, /倍率/);
});

test("Spark never becomes the main Codex Radar anchor", () => {
  const overview = buildModelOverview({
    models: [
      model("gpt-5.6-terra", ["medium"]),
      model("gpt-5.3-codex-spark", ["medium"]),
    ],
    sessions: [
      {
        model: "gpt-5.3-codex-spark",
        reasoningEffort: "medium",
        secondsPerPercent: 30,
        observationSeconds: 600,
      },
    ],
    state: {},
    now,
  });
  const terra = row(overview, "gpt-5.6-terra", "medium");
  const spark = row(overview, "gpt-5.3-codex-spark", "medium");
  assert.equal(terra.secondsPerPercent, null);
  assert.equal(terra.quotaPercentPerHour, null);
  assert.equal(spark.sourceKind, "local-only");
  assert.equal(spark.secondsPerPercent, 30);
});

test("unavailable Radar rows remain reference-only and current model metadata wins", () => {
  const overview = buildModelOverview({
    models: [model("gpt-6-astra", ["medium", "off"], { hidden: false })],
    sessions: [],
    state: {},
    now,
  });
  const luna = row(overview, "gpt-5.6-luna", "max");
  assert.equal(luna.available, false);
  assert.equal(luna.sourceKind, "radar-reference");
  assert.equal(luna.secondsPerPercent, null);
  assert.equal(
    row(overview, "gpt-6-astra", "medium").displayName,
    "GPT-6-ASTRA",
  );
  assert.equal(
    row(overview, "gpt-6-astra", "off").sourceLabel,
    "暂无该档位速率样本",
  );
});

test("invalid session values do not create NaN rates", () => {
  const overview = buildModelOverview({
    models: [model("gpt-5.6-terra", ["medium"])],
    sessions: [
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        secondsPerPercent: "not-a-number",
      },
    ],
    state: { gap: true },
    now,
  });
  const terra = row(overview, "gpt-5.6-terra", "medium");
  assert.equal(terra.secondsPerPercent, null);
  assert.equal(terra.quotaPercentPerHour, null);
  assert.equal(terra.sourceKind, "radar-reference");
  assert.ok(!JSON.stringify(overview).includes("NaN"));
});

test("current model samples are preferred to old historical averages", () => {
  const overview = buildModelOverview({
    models: [model("gpt-5.6-terra", ["medium"])],
    sessions: [
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        averageSecondsPerPercent: 10000,
        observationSeconds: 100000,
      },
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        secondsPerPercent: 100,
        observationSeconds: 60,
      },
      {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        averageSecondsPerPercent: 20000,
        observationSeconds: 100000,
      },
    ],
    now,
  });
  assert.equal(row(overview, "gpt-5.6-terra", "medium").secondsPerPercent, 100);
});
