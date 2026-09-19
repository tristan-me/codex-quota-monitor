import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SORT_MODES, orderSessionRows, filterSessionRows, moveSessionGroup,
  sessionSortPreference, sessionSortStorageKey,
} from '../web/dashboard-utils.mjs';

const epoch = 1_800_000_000_000;
const task = (id, values = {}) => ({ id, title: id, ...values });
const ids = rows => rows.map(row => row.id);

test('default time order follows newest activity and keeps whole families parent first', () => {
  const rows = orderSessionRows([
    task('grandchild', { parentThreadId: 'child', completedAt: epoch + 50_000 }),
    task('other', { startedAt: epoch + 40_000, status: 'active' }),
    task('child', { parentThreadId: 'parent', startedAt: epoch + 20_000 }),
    task('parent', { startedAt: epoch, status: 'idle' }),
    task('unknown'),
  ]);
  assert.deepEqual(ids(rows), ['parent', 'child', 'grandchild', 'other', 'unknown']);
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 0, 0]);
  assert.equal(rows[2].rootId, 'parent');
});

test('time ordering accepts recorded seconds, milliseconds, and ISO dates', () => {
  const rows = orderSessionRows([
    task('older', { completedAt: epoch }),
    task('newest', { updatedAt: new Date(epoch + 3000).toISOString() }),
    task('seconds', { startedAt: (epoch + 2000) / 1000 }),
    task('missing', { startedAt: null, completedAt: 'bad' }),
  ]);
  assert.deepEqual(ids(rows), ['newest', 'seconds', 'older', 'missing']);
});

test('metadata refreshes cannot move an older task ahead of newer lifecycle activity', () => {
  const rows = orderSessionRows([
    task('old', { startedAt: epoch, completedAt: epoch + 1000, updatedAt: epoch + 90_000 }),
    task('new', { latestTurnStartedAt: epoch + 5000, updatedAt: epoch + 10_000 }),
    task('fallback', { createdAt: epoch + 2000, updatedAt: epoch + 3000 }),
  ]);
  assert.deepEqual(ids(rows), ['new', 'fallback', 'old']);
});

test('nested children infer their parent while explicit descendant links remain intact', () => {
  const child = task('child', { children: [task('grandchild')] });
  const sessions = [task('parent', { children: [child, task('sibling', { parentSessionId: 'parent' })] }), child];
  const original = structuredClone(sessions);
  const rows = orderSessionRows(sessions);
  assert.deepEqual(ids(rows), ['parent', 'child', 'grandchild', 'sibling']);
  assert.deepEqual(rows.map(row => row.parentId), [null, 'parent', 'child', 'parent']);
  assert.deepEqual(sessions, original, 'ordering must not mutate snapshots');
});

test('total consumption sorts siblings in both directions and leaves unknown last', () => {
  const sessions = [task('parent', { totalEstimatedPercent: 0.3, children: [
    task('high', { totalEstimatedPercent: 0.2 }),
    task('unknown', { totalEstimatedPercent: null }),
    task('zero', { totalEstimatedPercent: 0 }),
    task('low', { totalEstimatedPercent: 0.1 }),
  ] }), task('other', { totalEstimatedPercent: 0.5 })];
  assert.deepEqual(ids(orderSessionRows(sessions, { sort: 'total-asc' })), ['parent', 'zero', 'low', 'high', 'unknown', 'other']);
  assert.deepEqual(ids(orderSessionRows(sessions, { sort: 'total-desc' })), ['other', 'parent', 'high', 'low', 'zero', 'unknown']);
});

test('Codex speed is the inverse mean, including idle tasks, with rate fallback only when needed', () => {
  const sessions = [
    task('slow', { status: 'idle', averageSecondsPerPercent: 100, latestTurnSecondsPerPercent: 1 }),
    task('unknown', { averageSecondsPerPercent: null, secondsPerPercent: 0 }),
    task('fast', { status: 'idle', averageSecondsPerPercent: 10, secondsPerPercent: null }),
    task('fallback', { averageSecondsPerPercent: null, latestTurnSecondsPerPercent: 50 }),
  ];
  assert.deepEqual(ids(orderSessionRows(sessions, { sort: 'speed-desc' })), ['fast', 'fallback', 'slow', 'unknown']);
  assert.deepEqual(ids(orderSessionRows(sessions, { sort: 'speed-asc' })), ['slow', 'fallback', 'fast', 'unknown']);
});

test('API consumption uses tokens and token speed with zero duration treated as unknown', () => {
  const sessions = [
    task('large', { totalTokens: 1000, totalElapsedSeconds: 100, averageSecondsPerPercent: 1 }),
    task('fast', { totalTokens: 500, totalElapsedSeconds: 10, secondsPerPercent: 500 }),
    task('zero', { totalTokens: 0, totalElapsedSeconds: 10, turnCount: 1 }),
    task('untimed', { totalTokens: 10, totalElapsedSeconds: 0 }),
    task('missing', { totalTokens: 0, turnCount: 0 }),
  ];
  assert.deepEqual(ids(orderSessionRows(sessions, { providerKind: 'api', sort: 'total-desc' })), ['large', 'fast', 'untimed', 'zero', 'missing']);
  assert.deepEqual(ids(orderSessionRows(sessions, { providerKind: 'api', sort: 'speed-desc' })), ['fast', 'large', 'zero', 'missing', 'untimed']);
  assert.deepEqual(ids(orderSessionRows(sessions, { providerKind: 'api', sort: 'speed-asc' })), ['zero', 'large', 'fast', 'missing', 'untimed']);
});

test('manual preference cannot put a descendant above its parent', () => {
  const sessions = [task('a', { children: [task('child', { children: [task('grandchild')] }), task('sibling')] }), task('b')];
  const rows = orderSessionRows(sessions, { sort: 'manual', manualOrder: ['grandchild', 'child', 'b', 'a', 'sibling'] });
  assert.deepEqual(ids(rows), ['b', 'a', 'child', 'grandchild', 'sibling']);
});

test('saved manual order survives polling order changes, removed tasks, and new arrivals', () => {
  const manualOrder = ['removed', 'b', 'a', 'child'];
  const sessions = [task('new', { startedAt: epoch + 2000 }), task('child', { parentThreadId: 'a' }), task('a'), task('b')];
  const options = { sort: 'manual', manualOrder };
  assert.deepEqual(ids(orderSessionRows(sessions, options)), ['b', 'a', 'child', 'new']);
  assert.deepEqual(ids(orderSessionRows(sessions.toReversed(), options)), ['b', 'a', 'child', 'new']);
});

test('search for a descendant retains all ancestor context; matching parents retain children', () => {
  const rows = orderSessionRows([task('root', { children: [
    task('parent', { children: [task('grandchild')] }), task('sibling'),
  ] }), task('other')]);
  assert.deepEqual(ids(filterSessionRows(rows, session => session.id === 'grandchild')), ['root', 'parent', 'grandchild']);
  assert.deepEqual(ids(filterSessionRows(rows, session => session.id === 'parent')), ['root', 'parent', 'grandchild']);
  assert.deepEqual(ids(filterSessionRows(rows, session => session.id === 'root')), ['root', 'parent', 'grandchild', 'sibling']);
  assert.deepEqual(filterSessionRows(rows, () => false), []);
});

const dragTasks = [task('a', { children: [
  task('a1', { children: [task('a1x')] }), task('a2', { children: [task('a2x')] }),
] }), task('b', { children: [task('b1')] }), task('c')];

test('dragging a root moves its whole family relative to the target family', () => {
  const rows = orderSessionRows(dragTasks);
  const before = moveSessionGroup(rows, 'b', 'a1x', 'before');
  assert.equal(before.targetId, 'a');
  assert.deepEqual(before.order, ['b', 'b1', 'a', 'a1', 'a1x', 'a2', 'a2x', 'c']);
  assert.deepEqual(moveSessionGroup(rows, 'a', 'b1', 'after').order, before.order);
  assert.deepEqual(ids(rows), ['a', 'a1', 'a1x', 'a2', 'a2x', 'b', 'b1', 'c']);
});

test('dragging a child moves its subtree among siblings without reparenting', () => {
  const rows = orderSessionRows(dragTasks);
  const result = moveSessionGroup(rows, 'a2', 'a1x', 'before');
  assert.deepEqual(result.order, ['a', 'a2', 'a2x', 'a1', 'a1x', 'b', 'b1', 'c']);
  const reloaded = orderSessionRows(dragTasks, { sort: 'manual', manualOrder: result.order });
  assert.deepEqual(ids(reloaded), result.order);
  assert.equal(reloaded.find(row => row.id === 'a2').parentId, 'a');
});

test('dropping on an ancestor, own descendant, or another parent is rejected', () => {
  const rows = orderSessionRows(dragTasks);
  for (const [source, target] of [['a1', 'a'], ['a', 'a1x'], ['a1', 'b1'], ['a1x', 'a2x'], ['a', 'a'], ['missing', 'b']]) {
    assert.equal(moveSessionGroup(rows, source, target), null, `${source} → ${target}`);
  }
});

test('every sort and accepted drop preserves ancestor order and contiguous families', () => {
  const check = rows => {
    const positions = new Map(rows.map((row, index) => [row.id, index]));
    const completedRoots = new Set();
    let root = null;
    for (const row of rows) {
      if (row.parentId) assert.ok(positions.get(row.parentId) < positions.get(row.id));
      if (root !== row.rootId) {
        if (root !== null) completedRoots.add(root);
        assert.ok(!completedRoots.has(row.rootId));
        root = row.rootId;
      }
    }
  };
  for (const sort of SESSION_SORT_MODES) {
    const rows = orderSessionRows(dragTasks, { sort, manualOrder: ['a2x', 'b1', 'c', 'a', 'b'] });
    check(rows);
    for (const source of rows) for (const target of rows) for (const placement of ['before', 'after']) {
      const result = moveSessionGroup(rows, source.id, target.id, placement);
      if (result) check(orderSessionRows(dragTasks, { sort: 'manual', manualOrder: result.order }));
    }
  }
});

test('orphan and cyclic parent links keep every task visible exactly once', () => {
  const rows = orderSessionRows([
    task('outside', { parentThreadId: 'a' }), task('a', { parentThreadId: 'b' }),
    task('b', { parentThreadId: 'a' }), task('orphan', { parentThreadId: 'absent' }),
    task('self', { parentThreadId: 'self' }),
  ]);
  assert.equal(rows.length, 5);
  assert.equal(new Set(ids(rows)).size, 5);
  assert.equal(rows.find(row => row.id === 'orphan').depth, 0);
  for (const row of rows) if (row.parentId) assert.ok(ids(rows).indexOf(row.parentId) < ids(rows).indexOf(row.id));
});

test('provider preferences are isolated, validated, and survive serialization', () => {
  assert.notEqual(sessionSortStorageKey('openai'), sessionSortStorageKey('muse'));
  assert.notEqual(sessionSortStorageKey('provider/a'), sessionSortStorageKey('provider%2Fa'));
  const preference = sessionSortPreference({ sort: 'manual', order: ['b', 'a', 'b', null, '', 1] });
  assert.deepEqual(preference, { sort: 'manual', order: ['b', 'a'] });
  assert.deepEqual(sessionSortPreference(JSON.parse(JSON.stringify(preference))), preference);
  assert.deepEqual(sessionSortPreference({ sort: 'invalid', order: {} }), { sort: 'time-desc', order: [] });
  assert.deepEqual(sessionSortPreference(null), { sort: 'time-desc', order: [] });
});
