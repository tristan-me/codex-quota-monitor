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

test("an average local anchor estimates another effort of the same model only", () => {
  const overview = buildModelOverview({
    models: [
      model("gpt-5.6-terra", ["medium"]),
      model("gpt-5.6-terra", ["high"]),
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
  const luna = row(overview, "gpt-5.6-terra", "high");
  assert.equal(terra.sourceKind, "local-average");
  assert.equal(terra.secondsPerPercent, 160);
  assert.ok(Math.abs(terra.quotaPercentPerHour - 3600 / 160) < 1e-12);
  assert.equal(luna.sourceKind, "radar-relative");
  assert.ok(luna.secondsPerPercent > 0);
  assert.ok(luna.quotaPercentPerHour > 0);
  assert.match(luna.rateBasis, /同一模型/);
  assert.deepEqual(luna.referenceAnchor, {model:"gpt-5.6-terra",effort:"medium"});
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

test("nested child family totals do not replace its own model rate", () => {
  const overview = buildModelOverview({
    models: [model("gpt-5.6-terra", ["medium"]), model("gpt-5.6-luna", ["high"])],
    sessions: [{
      model: "gpt-5.6-terra", reasoningEffort: "medium",
      ownStatus: "active", ownSecondsPerPercent: 120, ownObservationSeconds: 120,
      children: [{
        model: "gpt-5.6-luna", reasoningEffort: "high", status: "active",
        totalEstimatedPercent: 3, secondsPerPercent: 10, averageSecondsPerPercent: 10,
        ownStatus: "active", ownEstimatedPercent: 1, ownSecondsPerPercent: 60,
        ownAverageSecondsPerPercent: 60, ownObservationSeconds: 60,
        latestTurnSecondsPerPercent: 10,
      }],
    }], state: {}, now,
  });
  assert.equal(row(overview, "gpt-5.6-luna", "high").secondsPerPercent, 60);
  assert.equal(row(overview, "gpt-5.6-terra", "medium").secondsPerPercent, 120);
});

test('a cheap-model sample never invents expensive-model subscription rates', () => {
  const overview=buildModelOverview({models:[model('gpt-6-astra',['ultra','high']),model('gpt-5.6-luna',['max','low'])],
    sessions:[{model:'gpt-5.6-luna',reasoningEffort:'max',averageSecondsPerPercent:3000,observationSeconds:100000}],now});
  for(const effort of ['ultra','high']) {
    const astra=row(overview,'gpt-6-astra',effort);
    assert.equal(astra.secondsPerPercent,null);
    assert.equal(astra.calculationKind,'reference-only');
    assert.ok(astra.referenceCostPerHour>0);
  }
  assert.equal(row(overview,'gpt-5.6-luna','low').referenceAnchor.model,'gpt-5.6-luna');
});

test('a model uses its own anchor even when another model has much more history', () => {
  const overview=buildModelOverview({models:[model('gpt-6-astra',['ultra','high']),model('gpt-5.6-luna',['max'])],
    sessions:[{model:'gpt-5.6-luna',reasoningEffort:'max',averageSecondsPerPercent:3000,observationSeconds:100000},
      {model:'gpt-6-astra',reasoningEffort:'ultra',averageSecondsPerPercent:6000,observationSeconds:100}],now});
  const high=row(overview,'gpt-6-astra','high');
  assert.deepEqual(high.referenceAnchor,{model:'gpt-6-astra',effort:'ultra'});
  const ultra=row(overview,'gpt-6-astra','ultra');
  assert.ok(Math.abs(high.quotaPercentPerHour-(.6*high.referenceCostPerHour/ultra.referenceCostPerHour))<1e-12);
});

test('matched own-turn averages replace task lifetime and momentary spike rates', () => {
  const overview=buildModelOverview({models:[model('gpt-6-astra',['xhigh'])],sessions:[{
    model:'gpt-6-astra',reasoningEffort:'xhigh',ownStatus:'active',ownSecondsPerPercent:2,
    ownAverageSecondsPerPercent:10000,ownObservationSeconds:100000,
    ownLatestTurnElapsedSeconds:600,ownLatestTurnEstimatedPercent:.1,
    ownLatestTurnRateSource:'recent-token-calibrated',
    latestTurnElapsedSeconds:3600,latestTurnEstimatedPercent:10,children:[],
  }],now});
  const item=row(overview,'gpt-6-astra','xhigh');
  assert.equal(item.secondsPerPercent,6000);
  assert.equal(item.calculationKind,'turn-average');
});

test('missing own-turn usage never falls back to a differently scoped task average', () => {
  const overview=buildModelOverview({models:[model('gpt-6-astra',['xhigh'])],sessions:[{
    model:'gpt-6-astra',reasoningEffort:'xhigh',ownStatus:'idle',ownAverageSecondsPerPercent:10000,
    ownLatestTurnElapsedSeconds:600,ownLatestTurnEstimatedPercent:null,children:[],
  }],now});
  assert.equal(row(overview,'gpt-6-astra','xhigh').secondsPerPercent,null);
});
