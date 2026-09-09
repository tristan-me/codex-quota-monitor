import test from "node:test";
import assert from "node:assert/strict";
import { Estimator } from "../server/metrics.mjs";
import { Collector } from "../server/collector.mjs";

const start = 1_800_000_000_000;
const ms = (seconds) => start + seconds * 1000;
const task = (turn, tokens, seconds = 0, extra = {}) => ({
  id: "task", title: "Task", model: "gpt-5.6-terra", status: "active",
  startedAt: ms(seconds), tokens,
  activityEvidence: { turnId: turn }, ...extra,
});
const quota = (used = 10, reset = ms(1000)) => ({
  id: "codex:primary", bucket: "codex", windowMinutes: 10080,
  usedPercent: used, remainingPercent: 100 - used, resetsAt: reset,
});
function baseline(row = task("a", 0)) {
  const e = new Estimator();
  e.local([row], ms(0)); e.quota(quota(), ms(0), "account");
  return e;
}
const view = (e, row, seconds) => e.sessions([row], ms(seconds))[0];

test("delayed quota ticks keep prior-turn tokens out of the latest turn", () => {
  const e = baseline();
  e.local([task("a", 100)], ms(5));
  e.quota(quota(), ms(5), "account");
  e.local([task("b", 100, 10)], ms(10));
  assert.equal(view(e, task("b", 100, 10), 10).latestTurnEstimatedPercent, null);
  e.local([task("b", 150, 10)], ms(15));
  e.quota(quota(11), ms(15), "account");
  const row = view(e, task("b", 150, 10), 15);
  assert.equal(row.totalEstimatedPercent, 1);
  assert.ok(Math.abs(row.latestTurnEstimatedPercent - 1 / 3) < 1e-12);
});

test("a token jump spanning the turn boundary is not attributed to the new turn", () => {
  const e = baseline();
  e.local([task("a", 100)], ms(5));
  e.local([task("b", 160, 6)], ms(10));
  e.local([task("b", 200, 6)], ms(15));
  e.quota(quota(11), ms(15), "account");
  const row = view(e, task("b", 200, 6), 15);
  assert.equal(row.totalEstimatedPercent, 1);
  assert.ok(Math.abs(row.latestTurnEstimatedPercent - .2) < 1e-12);
});

test("quota reset discards old pending tokens without erasing confirmed current-turn usage", () => {
  const e = baseline();
  e.local([task("a", 100)], ms(5)); e.quota(quota(11), ms(5), "account");
  e.local([task("a", 200)], ms(10));
  e.quota(quota(0, ms(2000)), ms(10), "account");
  e.local([task("b", 200, 15)], ms(15));
  e.local([task("b", 250, 15)], ms(20));
  e.quota(quota(1, ms(2000)), ms(20), "account");
  const row = view(e, task("b", 250, 15), 20);
  assert.equal(row.totalEstimatedPercent, 2);
  assert.equal(row.latestTurnEstimatedPercent, 1);
});

test("restart preserves confirmed turn usage and drops unconfirmed offline deltas", () => {
  const e = baseline();
  e.local([task("a", 100)], ms(5)); e.quota(quota(11), ms(5), "account");
  e.local([task("a", 150)], ms(10));
  const restored = new Estimator(JSON.parse(JSON.stringify(e.state)));
  restored.local([task("a", 600)], ms(100));
  restored.quota(quota(13), ms(100), "account");
  const row = view(restored, task("a", 600), 100);
  assert.equal(row.latestTurnEstimatedPercent, 1);
  assert.equal(row.totalEstimatedPercent, 1);
  assert.equal(restored.state.unattributedPercent, 2);
  assert.equal(row.latestTurnCoverage, "partial-after-restart");
  assert.equal(row.latestTurnLastAttachedAt, ms(100));
});

test("missing and unknown observations cannot inflate latest-turn allocation", () => {
  const e = baseline();
  e.local([], ms(5));
  e.local([task("a", 100)], ms(10));
  e.local([task("a", 200, 0, { status: "unknown" })], ms(15));
  e.local([task("a", 300)], ms(20));
  e.quota(quota(11), ms(20), "account");
  assert.equal(view(e, task("a", 300), 20).latestTurnEstimatedPercent, null);
  e.local([task("a", 350)], ms(25));
  e.quota(quota(12), ms(25), "account");
  assert.equal(view(e, task("a", 350), 25).latestTurnEstimatedPercent, 1);
});

test("unknown token values are baselines, not zero-consumption evidence", () => {
  const e = baseline(task("a", 0, 0, { tokensKnown: false }));
  e.local([task("a", 1000)], ms(5));
  e.quota(quota(11), ms(5), "account");
  assert.equal(view(e, task("a", 1000), 5).latestTurnEstimatedPercent, null);
  assert.equal(e.state.unattributedPercent, 1);
});

test("root totals include children once and the latest family includes a same-turn child", () => {
  const e = new Estimator();
  const root = (tokens) => task("root-turn", tokens, 0, {
    executionHistory: { intervals: [[ms(-100), ms(-50)]], coverage: "local-records" },
  });
  const child = (tokens) => ({ ...task("child-turn", tokens), id: "child", parentThreadId: "task",
    executionHistory: { intervals: [[ms(-90), ms(-60)]], coverage: "local-records" } });
  e.local([root(0), child(0)], ms(0)); e.quota(quota(), ms(0), "account");
  e.local([root(100), child(100)], ms(30)); e.quota(quota(11), ms(30), "account");
  const row = e.sessions([root(100), child(100)], ms(30))[0];
  assert.equal(row.totalEstimatedPercent, 1);
  assert.equal(row.latestTurnEstimatedPercent, 1);
  assert.equal(row.children[0].latestTurnEstimatedPercent, .5);
  assert.equal(row.totalElapsedSeconds, 80);
  assert.equal(row.averageSecondsPerPercent, 80);
  assert.equal(row.latestTurnElapsedSeconds, 30);
  assert.equal(row.children[0].totalElapsedSeconds, 60);
});

test("completed latest duration uses explicit execution duration and makes no idle forecast", () => {
  const row = task("a", 10, 0, { status: "idle", completedAt: ms(50),
    activityEvidence: { turnId: "a", lastTurnDurationMs: 49_750 } });
  const e = baseline(row);
  const result = view(e, row, 100);
  assert.equal(result.latestTurnElapsedSeconds, 49.75);
  assert.equal(result.latestTurnSecondsPerPercent, null);
});

test("advancing a projection ordinal does not start another turn", () => {
  const e = baseline(task("a", 0, 0, { activityEvidence: { turnId: "a", turnSequence: 1 } }));
  e.local([task("a", 100, 0, { activityEvidence: { turnId: "a", turnSequence: 20 } })], ms(30));
  e.quota(quota(11), ms(30), "account");
  assert.equal(view(e, task("a", 100), 30).latestTurnEstimatedPercent, 1);
});

test("active tasks sort by start and idle tasks sort by completion", () => {
  const e = new Estimator();
  const a = { ...task("a", 0, 0), id: "a" };
  const b = { ...task("b", 0, 0), id: "b" };
  const c = { ...task("c", 0, 0), id: "c" };
  assert.deepEqual(e.sessions([a, b, c], ms(0)).map(x => x.id), ["a", "b", "c"]);
  const idleA = { ...a, status: "idle", completedAt: ms(5) };
  const newerB = { ...b, activityEvidence: { turnId: "b-new" }, startedAt: ms(2) };
  const middleC = { ...c, activityEvidence: { turnId: "c-new" }, startedAt: ms(1) };
  assert.deepEqual(e.sessions([middleC, idleA, newerB], ms(5)).map(x => x.id), ["b", "c", "a"]);
  assert.deepEqual(e.sessions([{ ...newerB, status: "idle", completedAt: ms(6) }, middleC, idleA], ms(6)).map(x => x.id), ["c", "b", "a"]);
});

test("ABC becomes ACB when B completes while A and C keep running", () => {
  const e = new Estimator();
  const a = { ...task("a", 0, 30), id: "A" };
  const b = { ...task("b", 0, 20), id: "B" };
  const c = { ...task("c", 0, 10), id: "C" };
  assert.deepEqual(e.sessions([c, b, a], ms(40)).map(row => row.id), ["A", "B", "C"]);
  const finishedB = { ...b, status: "idle", completedAt: ms(41) };
  assert.deepEqual(e.sessions([finishedB, c, a], ms(42)).map(row => row.id), ["A", "C", "B"]);
  const finishedC = { ...c, status: "idle", completedAt: ms(43) };
  assert.deepEqual(e.sessions([finishedC, finishedB, a], ms(44)).map(row => row.id), ["A", "C", "B"]);
});

test("regressed and unknown projections do not claim an old duration as the latest turn", () => {
  const e = baseline();
  e.local([task("b", 100, 10)], ms(15));
  e.local([task("b", 150, 10)], ms(20));
  e.quota(quota(11), ms(20), "account");
  e.local([task("a", 150)], ms(25));
  const regressed = view(e, task("a", 150), 25);
  assert.equal(regressed.latestTurnElapsedSeconds, null);
  assert.equal(regressed.latestTurnEstimatedPercent, null);
  const uncertain = task("b", 150, 10, { status: "unknown", completedAt: ms(30),
    activityEvidence: { turnId: "b", lastTurnDurationMs: 20_000 } });
  assert.equal(view(e, uncertain, 30).latestTurnElapsedSeconds, null);
  e.local([task("b", 150, 10)], ms(35));
  assert.equal(view(e, task("b", 150, 10), 35).latestTurnEstimatedPercent, 1 / 3);
});

test("a restored terminal projection becoming active does not erase confirmed allocations", () => {
  const e = baseline();
  e.local([task("a", 100)], ms(5)); e.quota(quota(11), ms(5), "account");
  e.local([task("a", 100, 0, { status: "idle", completedAt: ms(6) })], ms(7));
  const restored = new Estimator(JSON.parse(JSON.stringify(e.state)));
  restored.local([task("a", 100)], ms(10));
  assert.equal(view(restored, task("a", 100), 10).latestTurnEstimatedPercent, 1);
});

test("children sort by their latest own turn start", () => {
  const e = new Estimator();
  const root = task("root", 0, 0, { status: "idle", completedAt: ms(1) });
  const first = { ...task("first", 0, 0), id: "first", parentThreadId: "task" };
  const second = { ...task("second", 0, 1), id: "second", parentThreadId: "task" };
  e.sessions([root, first, second], ms(2));
  const result = e.sessions([{ ...first, status: "idle", completedAt: ms(3) }, root, second], ms(3))[0];
  assert.equal(result.status, "active");
  assert.deepEqual(result.children.map(row => row.id), ["second", "first"]);
});

test("paused or stale account snapshots suppress latest-turn forecasts for roots and children", () => {
  const at = Date.now() - 60000;
  const rows = (tokens) => [
    task("root", tokens, 0, { startedAt: at }),
    { ...task("child", tokens, 0, { startedAt: at }), id: "child", parentThreadId: "task" },
  ];
  const e = new Estimator();
  e.local(rows(0), at); e.quota(quota(), at, "account");
  e.local(rows(100), at + 30000); e.quota(quota(11), at + 30000, "account");
  e.local(rows(200), at + 59000);
  const c = new Collector({ dataDir: ".", reader: {}, client: {}, resetFetcher: null });
  c.estimator = e; c.threads = rows(200);
  c.account.lastFetchedAt = Date.now();
  const fresh = c.snapshot().sessions[0];
  assert.ok(fresh.latestTurnSecondsPerPercent > 0);
  assert.ok(fresh.children[0].latestTurnSecondsPerPercent > 0);
  c.settings.paused = true;
  const paused = c.snapshot().sessions[0];
  assert.equal(paused.latestTurnSecondsPerPercent, null);
  assert.equal(paused.children[0].latestTurnSecondsPerPercent, null);
  c.settings.paused = false; c.account.error = "offline";
  const stale = c.snapshot().sessions[0];
  assert.equal(stale.latestTurnSecondsPerPercent, null);
  assert.equal(stale.children[0].latestTurnSecondsPerPercent, null);
});

test('ABCD becomes ACBD then DACB then ACDB as tasks finish and restart', () => {
  const e=new Estimator();
  const a={...task('a',0,30),id:'A'},b={...task('b',0,20),id:'B'},c={...task('c',0,10),id:'C'};
  const d={...task('d-old',0,0),id:'D',status:'idle',completedAt:ms(5)};
  const ids=(rows,at)=>e.sessions(rows,ms(at)).map(r=>r.id);
  assert.deepEqual(ids([d,c,b,a],40),['A','B','C','D']);
  const doneB={...b,status:'idle',completedAt:ms(41)};
  assert.deepEqual(ids([d,c,doneB,a],42),['A','C','B','D']);
  const liveD={...task('d-new',0,43),id:'D'};
  assert.deepEqual(ids([liveD,c,doneB,a],44),['D','A','C','B']);
  const doneD={...liveD,status:'idle',completedAt:ms(45)};
  assert.deepEqual(ids([doneB,c,doneD,a],46),['A','C','D','B']);
  // Rename/update activity must not reorder a completed task.
  assert.deepEqual(ids([{...doneB,updatedAt:ms(48)},c,doneD,a],49),['A','C','D','B']);
});

test('idle parent completion order includes the last finished child', () => {
  const e=new Estimator();
  const parent={...task('p',0,0),id:'parent',status:'idle',completedAt:ms(10)};
  const child={...task('c',0,1),id:'child',parentThreadId:'parent',status:'idle',completedAt:ms(30)};
  const other={...task('o',0,5),id:'other',status:'idle',completedAt:ms(20)};
  const rows=e.sessions([other,parent,child],ms(40));
  assert.deepEqual(rows.map(r=>r.id),['parent','other']);
  assert.equal(rows[0].lastCompletedAt,ms(30));
});

test('window task elapsed grows until the window fills, then old and new time offset', () => {
  const e=new Estimator();
  const hour=3600;
  const active=task('continuous',0,0);
  assert.equal(view(e,active,2*hour).totalElapsedSeconds,2*hour);
  assert.equal(view(e,active,2*hour+60).totalElapsedSeconds,2*hour+60);
  // Full-window elapsed is bounded; it must not turn into lifetime wall time.
  assert.equal(view(e,active,25*hour).totalElapsedSeconds,24*hour);
  assert.equal(view(e,active,25*hour+60).totalElapsedSeconds,24*hour);
  const withPrior={...active,executionHistory:{intervals:[[ms(-24*hour),ms(0)]],coverage:'local-records'}};
  const first=view(e,withPrior,2*hour),next=view(e,withPrior,2*hour+60);
  assert.equal(first.totalElapsedSeconds,24*hour);
  assert.equal(next.totalElapsedSeconds,24*hour);
  assert.equal(next.latestTurnElapsedSeconds-first.latestTurnElapsedSeconds,60);
});
