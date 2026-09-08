import test from "node:test";
import assert from "node:assert/strict";
import {
  RESET_FORECAST_URL,
  RESET_METHODOLOGY_URL,
  RESET_ENDPOINT_REQUEST_COUNT,
  RESET_REFRESH_INTERVAL_MS,
  RESET_TIMELINE_URL,
  RESET_REFERENCE,
  buildResetRadar,
  fetchResetReference,
  normalizeReference,
} from "../server/reset-radar.mjs";

const now = Date.parse("2026-09-08T12:00:00.000Z");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function rawForecast(overrides = {}) {
  return {
    mode: "model",
    updated_at: "2026-09-08T05:01:50.684Z",
    probabilities: {
      raw_24h: 0.2915803600645666,
      raw_48h: 0.4981416137537509,
      rounded_24h: 30,
      rounded_48h: 50,
    },
    confidence: "low",
    confidence_note:
      "Experimental: walk-forward backtest has not beaten both baselines yet.",
    last_reset_at: "2026-09-08T04:05:53.000Z",
    official_signal: null,
    teased_window: null,
    time_window: {
      start_hour: 23,
      end_hour: 2,
      label: "11 PM - 2 AM",
      timezone: "UTC",
    },
    cadence: {
      recent_median_days: 2.1,
      recent_sample: 5,
      weighted_mean_days: 5,
      accelerating: true,
    },
    evidence: [
      {
        code: "recent_cadence",
        label: "Recent cadence",
        detail: "a reset every ~2.1d across the last 5",
        href: "/timeline",
      },
    ],
    model: {
      version: "rate-v3",
      window_intervals: 8,
      half_life_days: 60,
      effective_sample_size: 28.5,
    },
    backtest: {
      sample_size: 309,
      brier: 0.109,
      baseline_brier: 0.112,
      rate_v2_brier: 0.109,
      better_than_naive: true,
      better_than_rate_v2: false,
      status: "experimental",
    },
    ...overrides,
  };
}

function rawTimeline(events) {
  return {
    updated_at: "2026-09-08T04:48:22.111Z",
    events,
  };
}

function officialEvent(overrides = {}) {
  return {
    id: "official-current",
    date: "2026-09-08",
    type: "reset",
    group: "reset",
    summary: "All reset for everyone. Enjoy the week with Astra.",
    url: "https://x.com/thsottiaux/status/official-current",
    announced_at: "2026-09-08T04:05:53.000Z",
    effective_at: null,
    official_window: null,
    scope: "global",
    confidence: "medium",
    source: "live",
    source_label: "Live radar feed",
    is_reply: false,
    announcement_state: "announced",
    observation_result: "unknown",
    reset_verification_status: "pending",
    ...overrides,
  };
}

test("bundled reference exposes two public announcements and experimental forecast", () => {
  const radar = buildResetRadar({ reference: RESET_REFERENCE, now });
  assert.equal(RESET_REFERENCE.confirmed.length, 2);
  assert.equal(RESET_REFERENCE.last2.length, 2);
  assert.equal(RESET_REFERENCE.events.length, 2);
  assert.equal(radar.confirmed.length, 2);
  assert.deepEqual(
    radar.confirmed.map((event) => event.id),
    ["2097174560412246215", "2094252447271366730"],
  );
  assert.equal(radar.confirmed[0].timePrecision, "announcement-only");
  assert.equal(
    radar.confirmed[0].confirmationType,
    "official-completion-statement",
  );
  assert.equal(radar.confirmed[0].verification.isVerified, false);
  assert.equal(radar.confirmed[1].verification.isVerified, true);
  assert.equal(
    radar.confirmed[1].confirmationType,
    "verified-archive-announcement",
  );
  assert.equal(radar.forecast.state, "experimental");
  assert.equal(radar.forecast.probability24h, 0.2915803600645666);
  assert.equal(radar.forecast.probability48h, 0.4981416137537509);
  assert.equal(radar.forecast.officialWindow, null);
  assert.equal(radar.forecast.windowStart, "2026-09-08T23:00:00.000Z");
  assert.equal(radar.forecast.windowEnd, "2026-09-09T02:00:00.000Z");
  assert.match(radar.forecast.reason, /第三方实验性/);
  assert.match(radar.forecast.calculation, /历史公告兑现/);
  assert.match(radar.forecast.timeBasis, /UTC\+8/);
  assert.match(radar.forecast.timeBasis, /不对应24\/48小时概率/);
  assert.equal(radar.requestCount, RESET_ENDPOINT_REQUEST_COUNT);
  assert.ok(radar.notes.some((note) => /OpenAI 无关联/.test(note)));
  assert.ok(radar.notes.some((note) => /存储\/银行重置/.test(note)));
});

test("normalization keeps official reset announcements and excludes replies, banked credits, and observations", () => {
  const timeline = rawTimeline([
    officialEvent(),
    officialEvent({
      id: "archive-old",
      date: "2026-08-31",
      summary:
        "25M active users: to celebrate, usage reset for every paid ChatGPT Work and Codex subscription.",
      url: "https://x.com/thsottiaux/status/archive-old",
      announced_at: "2026-08-31T02:34:27.000Z",
      confidence: "high",
      source: "archive",
      source_label: "Verified archive",
      audience: ["codex", "chatgpt_work"],
      reset_kind: "hard",
      reset_verification_status: undefined,
    }),
    officialEvent({
      id: "reply",
      is_reply: true,
      announced_at: "2026-09-08T04:41:58.000Z",
      summary: "You forgot the part where I reset usage twice.",
    }),
    officialEvent({
      id: "banked",
      type: "credits",
      group: "credits",
      reset_kind: "banked",
      reason_tags: ["banked"],
      announced_at: "2026-09-05T00:39:25.000Z",
      summary: "A banked reset is arriving.",
    }),
    officialEvent({
      id: "operator-lyrics",
      source: "operator-observed",
      announced_at: "2026-09-08T01:34:00.000Z",
      summary:
        "Never gonna give you up\nNever gonna let you down\nNever gonna run around and desert you\nThanks",
    }),
  ]);
  const reference = normalizeReference(
    { timeline, forecast: rawForecast() },
    { now },
  );
  assert.deepEqual(
    reference.confirmed.map((event) => event.id),
    ["official-current", "archive-old"],
  );
  assert.equal(reference.events.length, 2);
  assert.equal(reference.confirmed[0].verification.status, "pending");
  assert.equal(
    reference.confirmed[0].confirmationType,
    "official-completion-statement",
  );
  assert.equal(reference.confirmed[1].verification.status, "archive-confirmed");
  assert.equal(
    reference.confirmed[1].confirmationType,
    "verified-archive-announcement",
  );
  assert.equal(reference.confirmed[1].audience[0], "codex");
  for (const event of reference.events) {
    for (const evidence of event.evidence) {
      assert.ok(evidence.excerpt.split(/\s+/).length <= 10);
      assert.doesNotMatch(
        evidence.excerpt.toLowerCase(),
        /never gonna|give you up|let you down/,
      );
    }
  }
});

test("long evidence excerpts are explicitly marked as truncated", () => {
  const reference = normalizeReference(
    {
      timeline: rawTimeline([
        officialEvent({
          summary:
            "Usage reset for every paid ChatGPT Work and Codex subscription after a long explanatory clause that must not be copied in full.",
        }),
      ]),
      forecast: rawForecast(),
    },
    { now },
  );
  const excerpt = reference.confirmed[0].evidence[0].excerpt;
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.split(/\s+/).length <= 10);
});

test("normalization accepts nested endpoint payloads and preserves raw probability fractions", () => {
  const reference = normalizeReference(
    {
      timeline: rawTimeline([officialEvent()]),
      forecast: rawForecast({
        probabilities: { rounded_24h: 30, rounded_48h: 50 },
      }),
    },
    { now },
  );
  assert.equal(reference.forecast.probability24h, 0.3);
  assert.equal(reference.forecast.probability48h, 0.5);
  assert.equal(reference.forecast.probability24hPercent, 30);
  assert.equal(reference.updatedAt, "2026-09-08T05:01:50.684Z");
  assert.equal(reference.forecast.lastResetAt, "2026-09-08T04:05:53.000Z");
  assert.equal(reference.methodologyUrl, RESET_METHODOLOGY_URL);
});

test("missing raw probabilities fall through to rounded values instead of becoming zero", () => {
  const reference = normalizeReference(
    {
      timeline: rawTimeline([]),
      forecast: rawForecast({
        probabilities: {
          raw_24h: null,
          raw_48h: null,
          rounded_24h: 30,
          rounded_48h: 50,
        },
      }),
    },
    { now },
  );
  assert.equal(reference.forecast.probability24h, 0.3);
  assert.equal(reference.forecast.probability48h, 0.5);
});

test("a future site-recorded official window takes priority over the historical observation window", () => {
  const reference = normalizeReference(
    {
      timeline: rawTimeline([]),
      forecast: rawForecast({
        teased_window: {
          label: "tomorrow morning",
          start_at: "2026-09-09T01:00:00.000Z",
          end_at: "2026-09-09T02:00:00.000Z",
          time_zone: "UTC",
        },
      }),
    },
    { now },
  );
  const radar = buildResetRadar({ reference, now });
  assert.equal(radar.forecast.officialWindow.label, "tomorrow morning");
  assert.equal(radar.forecast.windowStart, "2026-09-09T01:00:00.000Z");
  assert.equal(radar.forecast.windowEnd, "2026-09-09T02:00:00.000Z");
  assert.match(radar.forecast.timeBasis, /官方预告\/站点收录/);
  assert.match(radar.forecast.timeBasis, /24\/48小时概率/);

  const expired = buildResetRadar({
    reference,
    now: Date.parse("2026-09-09T03:00:00.000Z"),
  });
  assert.equal(expired.forecast.officialWindow, null);
  assert.equal(expired.forecast.windowStart, "2026-09-09T23:00:00.000Z");
});

test("an official window already fulfilled by the last reset is not reused", () => {
  const reference = normalizeReference(
    {
      timeline: rawTimeline([]),
      forecast: rawForecast({
        last_reset_at: "2026-09-09T01:30:00.000Z",
        teased_window: {
          label: "tomorrow morning",
          start_at: "2026-09-09T01:00:00.000Z",
          end_at: "2026-09-09T02:00:00.000Z",
          time_zone: "UTC",
        },
      }),
    },
    { now: Date.parse("2026-09-09T03:00:00.000Z") },
  );
  const radar = buildResetRadar({
    reference,
    now: Date.parse("2026-09-09T03:00:00.000Z"),
  });
  assert.equal(radar.forecast.officialWindow, null);
  assert.equal(radar.forecast.windowStart, "2026-09-09T23:00:00.000Z");
});

test("legacy normalized state with forty events compacts to two and preserves a future official window", () => {
  const current = normalizeReference(
    {
      timeline: rawTimeline([officialEvent()]),
      forecast: rawForecast({
        teased_window: {
          label: "tomorrow morning",
          start_at: "2026-09-09T01:00:00.000Z",
          end_at: "2026-09-09T02:00:00.000Z",
          time_zone: "UTC",
        },
      }),
    },
    { now },
  );
  const legacyEvents = Array.from({ length: 40 }, (_, index) => ({
    ...current.confirmed[0],
    id: `legacy-${index}`,
    announcementAt: new Date(now - index * 60_000).toISOString(),
  }));
  const compacted = normalizeReference(
    {
      ...current,
      confirmed: [legacyEvents[0]],
      last2: [],
      events: legacyEvents,
    },
    { now },
  );
  assert.equal(compacted.events.length, 2);
  assert.deepEqual(
    compacted.confirmed.map((event) => event.id),
    ["legacy-0", "legacy-1"],
  );
  assert.equal(compacted.forecast.officialWindow.label, "tomorrow morning");
  const radar = buildResetRadar({ reference: compacted, now });
  assert.equal(radar.forecast.officialWindow.label, "tomorrow morning");
  assert.equal(radar.forecast.windowStart, "2026-09-09T01:00:00.000Z");
});

test("fetchResetReference uses only public GET endpoints and normalizes both responses", async () => {
  const requests = [];
  const timeline = rawTimeline([officialEvent()]);
  const forecast = rawForecast();
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return url === RESET_TIMELINE_URL
      ? jsonResponse(timeline)
      : jsonResponse(forecast);
  };
  const reference = await fetchResetReference({ fetchImpl, now });
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [RESET_FORECAST_URL, RESET_TIMELINE_URL].sort(),
  );
  for (const request of requests) {
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.accept, "application/json");
    assert.equal(request.options.headers["cache-control"], "no-cache");
  }
  assert.equal(reference.fetchedAt, "2026-09-08T12:00:00.000Z");
  assert.equal(reference.requestCount, RESET_ENDPOINT_REQUEST_COUNT);
  assert.equal(reference.confirmed[0].id, "official-current");
});

test("fetchResetReference fails closed when a public endpoint is unavailable", async () => {
  const fetchImpl = async (url) =>
    url === RESET_FORECAST_URL
      ? jsonResponse({ error: "temporary" }, 503)
      : jsonResponse(rawTimeline([]));
  await assert.rejects(
    fetchResetReference({ fetchImpl, now }),
    /public endpoint failed \(503\)/,
  );
});

test("cross-midnight historical window remains anchored to the current UTC interval", () => {
  const beforeWindow = buildResetRadar({
    reference: RESET_REFERENCE,
    now: Date.parse("2026-09-08T22:00:00.000Z"),
  });
  const insideWindow = buildResetRadar({
    reference: RESET_REFERENCE,
    now: Date.parse("2026-09-09T00:30:00.000Z"),
  });
  const afterWindow = buildResetRadar({
    reference: RESET_REFERENCE,
    now: Date.parse("2026-09-09T02:30:00.000Z"),
  });
  assert.equal(beforeWindow.forecast.windowStart, "2026-09-08T23:00:00.000Z");
  assert.equal(insideWindow.forecast.windowStart, "2026-09-08T23:00:00.000Z");
  assert.equal(insideWindow.forecast.windowEnd, "2026-09-09T02:00:00.000Z");
  assert.equal(afterWindow.forecast.windowStart, "2026-09-09T23:00:00.000Z");
});

test("refresh expiry is exactly one fifteen-minute scheduler interval after fetch", async () => {
  const reference = await fetchResetReference({
    fetchImpl: async (url) =>
      url === RESET_TIMELINE_URL
        ? jsonResponse(rawTimeline([]))
        : jsonResponse(rawForecast()),
    now,
  });
  const radar = buildResetRadar({ reference, now });
  assert.equal(
    Date.parse(radar.forecast.expiresAt),
    now + RESET_REFRESH_INTERVAL_MS,
  );
  assert.equal(radar.forecast.stale, false);
});

test("published website percentages remain distinct from raw model probabilities", () => {
  const ref = normalizeReference(
    { timeline: rawTimeline([officialEvent()]), forecast: rawForecast() },
    { now },
  );
  assert.equal(ref.forecast.probability24h, 0.2915803600645666);
  assert.equal(ref.forecast.probability24hPercent, 30);
  assert.equal(ref.forecast.probability48hPercent, 50);
});
test("a future tease is not treated as a completed reset announcement", () => {
  const ref = normalizeReference(
    {
      timeline: rawTimeline([
        officialEvent({
          summary: "We will reset all paid usage tomorrow.",
          id: "future",
        }),
      ]),
      forecast: rawForecast(),
    },
    { now },
  );
  assert.equal(ref.confirmed.length, 0);
});
