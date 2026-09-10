import test from 'node:test';
import assert from 'node:assert/strict';
import { Estimator } from '../server/metrics.mjs';
const now=1_800_000_000_000, hour=3_600_000;
const done=(id,start,end,parentThreadId=null)=>({id,title:id,model:'gpt-6-astra',
  status:'idle',startedAt:start,completedAt:end,updatedAt:end,parentThreadId,
  activityEvidence:{turnId:`${id}-turn`},
  executionHistory:{intervals:[[start,end]],turns:[{turnId:`${id}-turn`,startedAt:start,completedAt:end,status:'idle'}],coverage:'local-records'}});

test('all known task history survives a smaller account window, missing source, and restart',()=>{
  const e=new Estimator({legacyAggregateMigrated:true,retentionHours:168});
  const start=now-1000*hour, end=start+2*hour;
  const root=done('known-root',start,end),child=done('known-child',start+hour,end,'known-root');
  e.state.rollingAllocations=[{id:root.id,at:end,startAt:start,endAt:end,percent:2},
    {id:child.id,at:end,startAt:start+hour,endAt:end,percent:1}];
  e.local([root,child],now);
  e.setRetentionHours(1,now);
  const restored=new Estimator(JSON.parse(JSON.stringify(e.state)));
  const result=restored.sessions([],now+300*hour)[0];
  assert.equal(result.totalElapsedSeconds,7200);
  assert.equal(result.totalEstimatedPercent,3);
  assert.equal(result.averageSecondsPerPercent,2400);
  assert.equal(result.children.length,1);
  assert.equal(result.status,'idle');
  assert.equal(restored.state.rollingQuotaEvents.length,0);
  assert.deepEqual(restored.rollingCalibration(now+300*hour),{tokens:0,percent:0});
});

test('an unavailable formerly active task freezes at its last known sample',()=>{
  const e=new Estimator();
  e.local([{id:'missing-active',model:'gpt-6-astra',status:'active',startedAt:now-hour,
    tokens:0,activityEvidence:{turnId:'active-turn'}}],now);
  const restored=new Estimator(JSON.parse(JSON.stringify(e.state)));
  const row=restored.sessions([],now+10*hour)[0];
  assert.equal(row.status,'unknown');
  assert.equal(row.totalElapsedSeconds,3600);
  assert.equal(row.latestTurnElapsedSeconds,null);
  assert.equal(row.secondsPerPercent,null);
  assert.equal(row.totalEstimatedPercent,null);
});

test('known sample mean excludes older unmatched time and incompletely covered quota intervals',()=>{
  const e=new Estimator({legacyAggregateMigrated:true});
  const thread=done('partial',now-1000*hour,now-999*hour);
  thread.executionHistory.intervals.push([now-10000,now]);
  e.state.rollingAllocations=[{id:'partial',at:now,startAt:now-10000,endAt:now,percent:2},
    {id:'partial',at:now-20000,startAt:now-30000,endAt:now-20000,percent:4}];
  const row=e.sessions([thread],now)[0];
  assert.equal(row.totalElapsedSeconds,3610);
  assert.equal(row.totalEstimatedPercent,6);
  assert.equal(row.averageSecondsPerPercent,5);
});

test('old task usage never returns to current calibration or account attribution',()=>{
  const identity='synthetic-account:window';
  const e=new Estimator({legacyAggregateMigrated:true,retentionHours:1,
    previous:{identity},rollingStartedAt:now-10*hour});
  e.state.rollingAllocations=[{id:'old',at:now-5*hour,percent:20,tokens:100000,quotaIdentity:identity},
    {id:'new',at:now-1000,percent:1,tokens:100,quotaIdentity:identity}];
  e.pruneRolling(now);
  assert.deepEqual(e.rollingCalibration(now),{tokens:100,percent:1});
  assert.equal(e.state.totals.old,20);
  assert.equal(e.state.rollingQuotaEvents.length,1);
  e.pruneRolling(now+2*hour);
  assert.equal(e.state.rollingQuotaEvents.length,0);
  assert.equal(e.state.totals.old,20);
});
