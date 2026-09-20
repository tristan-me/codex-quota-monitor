import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalReader } from '../server/local-reader.mjs';

const NOW = 1_800_000_000_000;
const START = NOW - 20_000;
const FIRST_MODEL = 'gpt-6-astra';
const SECOND_MODEL = 'gpt-5.6-luna';
const usage = n => ({ input_tokens: 1000 * n, cached_input_tokens: 900 * n,
  output_tokens: 100 * n, reasoning_output_tokens: 50 * n, total_tokens: 1100 * n });
const normalizedUsage = n => ({ inputTokens: 1000 * n, cachedInputTokens: 900 * n,
  outputTokens: 100 * n, totalTokens: 1100 * n });
const event = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n';
const session = () => event(START - 1000, 'session_meta', { model_provider: 'muse' });
const start = (id, at = START) => event(at, 'event_msg', { type: 'task_started', turn_id: id });
const context = (id, at, metadata) => event(at, 'turn_context', { turn_id: id, ...metadata });
const count = (n, at, last = 1) => event(at, 'event_msg', { type: 'token_count',
  info: { total_token_usage: usage(n), last_token_usage: usage(last) } });
const complete = (id, at) => event(at, 'event_msg', { type: 'task_complete', turn_id: id });
const part = (model, serviceTier, n) => ({ model, serviceTier, tokenUsage: normalizedUsage(n) });

async function fixture(t, rollout) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pricing-usage-reader-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'rollout.jsonl');
  await fs.writeFile(file, rollout);
  const reader = new LocalReader({ codexHome: home, now: NOW });
  return { home, file, reader, read() {
    const diagnostics = { rolloutErrors: 0, errors: [], legacyRolloutsRead: 0,
      rolloutBytesRead: 0, malformedRolloutLines: 0 };
    const result = reader.readRollout(file, diagnostics, { modelProvider: 'muse' });
    assert.ok(result);
    assert.equal(diagnostics.rolloutErrors, 0);
    return { result, diagnostics };
  } };
}

function turn(result, id) {
  const found = result.executionHistory.turns.find(value => value.turnId === id);
  assert.ok(found, `missing synthetic turn ${id}`);
  return found;
}

function assertConserved(record) {
  const sum = record.pricingUsage.reduce((total, row) => {
    assert.deepEqual(Object.keys(row).sort(), ['model', 'serviceTier', 'tokenUsage']);
    assert.deepEqual(Object.keys(row.tokenUsage).sort(), ['cachedInputTokens', 'inputTokens', 'outputTokens', 'totalTokens']);
    for (const field of Object.keys(total)) total[field] += row.tokenUsage[field];
    return total;
  }, normalizedUsage(0));
  assert.deepEqual(sum, record.tokenUsage || normalizedUsage(0));
}

test('pricing usage groups each counted increment by its recorded model and tier, including returns to an earlier context', async t => {
  const id = 'switching-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) + count(1, START + 200) +
    context(id, START + 300, { model: SECOND_MODEL, service_tier: 'standard' }) + count(3, START + 400, 2) +
    context(id, START + 500, { model: SECOND_MODEL, service_tier: 'priority' }) + count(4, START + 600) +
    context(id, START + 700, { model: FIRST_MODEL, service_tier: 'standard' }) + count(5, START + 800) +
    context(id, START + 900, { model: FIRST_MODEL }) + count(6, START + 1000) + complete(id, START + 1100));
  const found = turn(f.read().result, id);
  assert.deepEqual(found.pricingUsage, [
    part(FIRST_MODEL, 'standard', 2), part(SECOND_MODEL, 'standard', 2),
    part(SECOND_MODEL, 'priority', 1), part(FIRST_MODEL, null, 1),
  ]);
  assert.equal(found.model, FIRST_MODEL);
  assert.equal(found.serviceTier, null);
  assert.equal(found.modelProvider, 'muse');
  assert.equal(found.costCredits, null);
  assert.equal(found.usageCoverage, 'recorded-turn');
  assertConserved(found);
});

test('zero and repeated token snapshots do not create charges or empty model groups across cached reads', async t => {
  const id = 'cached-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) + count(0, START + 200, 0));
  const zero = turn(f.read().result, id);
  assert.deepEqual(zero.pricingUsage, []);
  assertConserved(zero);

  await fs.appendFile(f.file, count(1, START + 300));
  const first = turn(f.read().result, id);
  assert.deepEqual(first.pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
  const cached = f.read();
  assert.equal(cached.diagnostics.rolloutBytesRead, 0);
  assert.deepEqual(turn(cached.result, id).pricingUsage, first.pricingUsage);

  await fs.appendFile(f.file, count(1, START + 400) +
    context(id, START + 500, { model: SECOND_MODEL, service_tier: 'fast' }) + count(1, START + 600));
  const repeated = turn(f.read().result, id);
  assert.deepEqual(repeated.pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
  await fs.appendFile(f.file, count(2, START + 700));
  const next = turn(f.read().result, id);
  assert.deepEqual(next.pricingUsage, [part(FIRST_MODEL, 'standard', 1), part(SECOND_MODEL, 'fast', 1)]);
  assertConserved(next);
  assert.deepEqual(first.pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
});

test('a truncated cumulative prefix prices only the increments the reader actually counted', async t => {
  const id = 'partial-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) +
    count(10, START + 200) + count(11, START + 300) + complete(id, START + 400));
  const found = turn(f.read().result, id);
  assert.equal(found.usageCoverage, 'partial-turn');
  assert.deepEqual(found.tokenUsage, normalizedUsage(1));
  assert.deepEqual(found.pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
  assertConserved(found);
});

test('missing model or tier remains explicit and unsupported model names are preserved without price guesses', async t => {
  const id = 'unknown-context-turn';
  const f = await fixture(t, session() + start(id) + count(1, START + 100) +
    context(id, START + 200, { service_tier: 'standard' }) + count(2, START + 300) +
    context(id, START + 400, { model: 'unlisted-synthetic-model' }) + count(3, START + 500) +
    context(id, START + 600, { model: SECOND_MODEL, service_tier: 'standard' }) + count(4, START + 700));
  const found = turn(f.read().result, id);
  assert.deepEqual(found.pricingUsage, [part(null, null, 1), part(null, 'standard', 1),
    part('unlisted-synthetic-model', null, 1), part(SECOND_MODEL, 'standard', 1)]);
  assertConserved(found);
});

test('a repeated prior-turn cumulative snapshot does not transfer its usage to the next model', async t => {
  const f = await fixture(t, session() + start('first') +
    context('first', START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) +
    count(1, START + 200) + complete('first', START + 300) + start('second', START + 400) +
    context('second', START + 500, { model: SECOND_MODEL, service_tier: 'flex' }) +
    count(1, START + 600) + count(2, START + 700) + complete('second', START + 800));
  const result = f.read().result;
  assert.deepEqual(turn(result, 'first').pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
  assert.deepEqual(turn(result, 'second').pricingUsage, [part(SECOND_MODEL, 'flex', 1)]);
  for (const record of result.executionHistory.turns) assertConserved(record);
});

test('an unterminated final token line is retried without duplicating pricing usage after an append', async t => {
  const id = 'unterminated-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) + count(1, START + 200).trimEnd());
  assert.deepEqual(turn(f.read().result, id).pricingUsage, [part(FIRST_MODEL, 'standard', 1)]);
  await fs.appendFile(f.file, '\n' + count(1, START + 300) +
    context(id, START + 400, { model: SECOND_MODEL, service_tier: 'standard' }) + count(2, START + 500).trimEnd());
  const found = turn(f.read().result, id);
  assert.deepEqual(found.pricingUsage, [part(FIRST_MODEL, 'standard', 1), part(SECOND_MODEL, 'standard', 1)]);
  assertConserved(found);
});

test('tokens from older cached metadata without a breakdown stay unknown when new pricing context arrives', async t => {
  const id = 'older-cache-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) + count(1, START + 200));
  f.read();
  const cachedTurn = f.reader.rolloutCache.get(f.file).result.lifecycleTurns.find(record => record.turnId === id);
  delete cachedTurn.pricingUsage;
  await fs.appendFile(f.file, context(id, START + 300, { model: SECOND_MODEL, service_tier: 'standard' }) + count(2, START + 400));
  const found = turn(f.read().result, id);
  assert.deepEqual(found.pricingUsage, [part(null, null, 1), part(SECOND_MODEL, 'standard', 1)]);
  assertConserved(found);
});

test('a rewritten rollout rebuilds its pricing groups instead of retaining the old models', async t => {
  const f = await fixture(t, session() + start('old') +
    context('old', START + 100, { model: FIRST_MODEL, service_tier: 'standard' }) + count(1, START + 200));
  f.read();
  await fs.writeFile(f.file, session() + start('replacement') +
    context('replacement', START + 100, { model: SECOND_MODEL, service_tier: 'standard' }) +
    count(2, START + 200, 2) + complete('replacement', START + 300));
  const result = f.read().result;
  assert.equal(result.executionHistory.turns.length, 1);
  const found = turn(result, 'replacement');
  assert.deepEqual(found.pricingUsage, [part(SECOND_MODEL, 'standard', 2)]);
  assertConserved(found);
});

test('a newer SQLite completion and current thread model do not erase the rollout pricing breakdown', async t => {
  const id = 'merged-turn';
  const f = await fixture(t, session() + start(id) +
    context(id, START + 100, { model: FIRST_MODEL, service_tier: 'priority', model_provider: 'muse' }) + count(1, START + 200));
  const stateDb = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  stateDb.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, model TEXT,
    model_provider TEXT, tokens_used INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER,
    rollout_path TEXT, history_mode TEXT)`);
  stateDb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-pricing-task', 'Synthetic pricing task', SECOND_MODEL, 'muse', 1100,
      NOW, START - 1000, f.file, 'legacy');
  stateDb.close();
  const historyDb = new DatabaseSync(path.join(f.home, 'thread_history_1.sqlite'));
  historyDb.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
    status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, model_provider TEXT)`);
  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-pricing-task', id, 1, 'completed', START, START + 10_000, 10_000, 'muse');
  historyDb.close();

  const result = f.reader.read();
  assert.equal(result.threads[0].model, SECOND_MODEL);
  const found = turn(result.threads[0], id);
  assert.equal(found.status, 'idle');
  assert.equal(found.completedAt, START + 10_000);
  assert.equal(found.durationMs, 10_000);
  assert.deepEqual(found.pricingUsage, [part(FIRST_MODEL, 'priority', 1)]);
  assertConserved(found);
  const cached = f.reader.read();
  assert.equal(cached.diagnostics.rolloutBytesRead, 0);
  assert.deepEqual(turn(cached.threads[0], id).pricingUsage, found.pricingUsage);
});
