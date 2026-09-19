import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskPercent, resetDeadline } from '../web/dashboard-utils.mjs';

test('quota precision increases two decimals at a time for smaller amounts', () => {
  for (const [input, expected] of [
    [0, '0.00%'], [1.23456, '1.23%'], [0.5, '0.50%'], [0.026312345, '0.03%'],
    [0.01, '0.01%'], [0.009999, '0.0100%'], [0.00123456, '0.0012%'],
    [0.0001, '0.0001%'], [0.0000123456, '0.000012%'], [0.000001, '0.000001%'],
    [0.000000263, '0.00000026%'], [0.00000004, '0.00000004%'], [1e-10, '0.0000000001%'],
  ]) assert.equal(formatTaskPercent(input), expected);
});

test('positive amounts remain nonzero across all representable magnitudes', () => {
  for (let exponent = 0; exponent <= 323; exponent += 1) {
    const value = Number(`1e-${exponent}`);
    const formatted = formatTaskPercent(value);
    assert.ok(Number(formatted.slice(0, -1)) > 0, `${value} became ${formatted}`);
  }
  assert.equal(formatTaskPercent(Number.MIN_VALUE), '5e-324%');
  assert.equal(Number(formatTaskPercent(Number.MIN_VALUE).slice(0, -1)), Number.MIN_VALUE);
  assert.ok(!formatTaskPercent(1e-100).includes('e'));
});

test('unavailable quota amounts are distinct from recorded zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '', '  ', 'invalid', false, {}]) {
    assert.equal(formatTaskPercent(value), '待估算');
  }
  assert.equal(formatTaskPercent('0.000004'), '0.000004%');
  assert.equal(formatTaskPercent('0'), '0.00%');
});

test('rendering an old snapshot while polling cannot restart the reset countdown',()=>{
  const now=1_800_000_000_000;
  const snapshot={now,reset:{scheduledAt:now+100000,secondsUntil:100}};
  const values=[0,1000,4000,5000,5100,6000,10000].map(elapsed=>
    (resetDeadline(snapshot.reset,snapshot.now)-(now+elapsed))/1000);
  assert.deepEqual(values,[100,99,96,95,94.9,94,90]);
  assert.equal(resetDeadline({secondsUntil:100},now),now+100000);
  assert.equal(resetDeadline({...snapshot.reset,stale:true},now),null);
  assert.equal(resetDeadline({scheduledAt:now+200000},now),now+200000);
});
