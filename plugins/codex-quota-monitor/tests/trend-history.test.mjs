import test from 'node:test';
import assert from 'node:assert/strict';
import { Estimator, normalizeQuotaHistory } from '../server/metrics.mjs';
const now = 1_800_000_000_000;
const hour = 3600000;
const quota = (used, resetsAt = now + 7 * 24 * hour) => ({ id:'codex:primary', bucket:'codex', windowMinutes:10080, usedPercent:used, remainingPercent:100-used, resetsAt });

test('quota trend preserves pre-reset samples and survives restart inside the retention window', () => {
  const e=new Estimator();
  e.quota(quota(80),now-hour,'example-account');
  e.quota(quota(90),now-30_000,'example-account');
  e.quota(quota(0,now+8*24*hour),now,'example-account');
  assert.deepEqual(e.state.history.map(p=>p.remainingPercent),[20,10,100]);
  assert.equal(e.state.history.at(-1).reset,true);
  const restored=new Estimator(structuredClone(e.state));
  restored.quota(quota(1,now+8*24*hour),now+30_000,'example-account');
  assert.deepEqual(restored.state.history.map(p=>p.remainingPercent),[20,10,100,99]);
  restored.setRetentionHours(1,now+60_000);
  assert.deepEqual(restored.state.history.map(p=>p.remainingPercent),[10,100,99]);
});

test('reset timestamp updates do not erase the remaining-quota timeline', () => {
  const e=new Estimator();
  e.quota(quota(10),now,'example-account');
  e.quota(quota(11,now+7*24*hour+1000),now+30_000,'example-account');
  assert.deepEqual(e.state.history.map(p=>p.remainingPercent),[90,89]);
});

test('switching account or quota unit clears incompatible trend samples', () => {
  const e=new Estimator();
  e.quota(quota(80),now,'account-one');
  e.quota(quota(5),now+1000,'account-two');
  assert.deepEqual(e.state.history.map(p=>p.remainingPercent),[95]);
  e.quota({...quota(2),windowMinutes:300},now+2000,'account-two');
  assert.deepEqual(e.state.history.map(p=>p.remainingPercent),[98]);
});

test('valid samples after corruption are retained and ordered without fabricating missing history', () => {
  const points=[{at:now-25*hour,remainingPercent:99},{at:now-12*hour,remainingPercent:500},null,
    {at:'bad',remainingPercent:50},{at:now-3*hour,remainingPercent:80},
    {at:now-hour,remainingPercent:70},{at:now+1000,remainingPercent:60},
    {at:now-3*hour,remainingPercent:81},{at:now-2*hour,remainingPercent:null}];
  assert.deepEqual(normalizeQuotaHistory(points,now-24*hour,now),[
    {at:now-3*hour,remainingPercent:81},{at:now-hour,remainingPercent:70}]);
});
