import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskPercent, resetDeadline } from '../web/dashboard-utils.mjs';

test('small task amounts use at most six decimal places without rounding tiny values to zero',()=>{
  assert.equal(formatTaskPercent(0.026312345),'0.026312%');
  assert.equal(formatTaskPercent(0.5),'0.5%');
  assert.equal(formatTaskPercent(0.000001),'0.000001%');
  assert.equal(formatTaskPercent(0.00000004),'<0.000001%');
  assert.equal(formatTaskPercent(1.23456),'1.23%');
  assert.equal(formatTaskPercent(null),'待估算');
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
