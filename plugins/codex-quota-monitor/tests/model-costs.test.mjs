import test from 'node:test';
import assert from 'node:assert/strict';
import { COST_RATE_VERSION, tokenUsage, usageCredits } from '../server/usage-cost.mjs';
import { Estimator } from '../server/metrics.mjs';
const now=1_800_000_000_000;
const unit='sample:codex:10080';
const saved=()=>({legacyAggregateMigrated:true,accountUnit:unit,
  previous:{accountKey:'sample',identity:'sample:codex:primary:1',used:10,at:now},
  costCalibrationSamples:[{id:'synthetic-anchor',at:now,version:COST_RATE_VERSION,
    accountUnit:unit,credits:100,percent:1}]});
const turn=(id,start,end,credits,model='gpt-5.6-luna')=>({turnId:id,startedAt:start,
  completedAt:end,status:end===null?'active':'idle',model,reasoningEffort:'max',
  costCredits:credits,costTokens:1000,costRateVersion:COST_RATE_VERSION,costCoverage:'recorded-turn'});
const thread=(id,turns,extra={})=>({id,title:id,model:'gpt-5.6-luna',reasoningEffort:'max',
  status:turns.at(-1).status,startedAt:turns.at(-1).startedAt,completedAt:turns.at(-1).completedAt,
  tokens:1000,tokensKnown:true,activityEvidence:{turnId:turns.at(-1).turnId},
  executionHistory:{turns,intervals:turns.filter(t=>t.completedAt).map(t=>[t.startedAt,t.completedAt]),coverage:'local-records'},...extra});

test('model, cached-input, output and fast-mode weights are distinct; reasoning is not charged twice',()=>{
  const usage=tokenUsage({input_tokens:1000000,cached_input_tokens:900000,output_tokens:100000,reasoning_output_tokens:90000});
  assert.equal(usageCredits(usage,'gpt-6-astra'),172.5);
  assert.equal(usageCredits(usage,'gpt-5.6-luna'),3.95);
  assert.equal(usageCredits(usage,'gpt-6-astra','fast'),431.25);
  assert.equal(usageCredits(usage,'unknown-model'),null);
  assert.equal(usageCredits(usage,'gpt-5.6-luna','priority'),null);
  assert.equal(tokenUsage({input_tokens:1,cached_input_tokens:2,output_tokens:0}),null);
});

test('equal token increments allocate very different quota shares to Astra and Luna',()=>{
  const e=new Estimator();
  const rows=(tokens,a,l)=>[
    {id:'astra',model:'gpt-6-astra',status:'active',startedAt:now,tokens,tokensKnown:true,
      usageCredits:a,costRateVersion:COST_RATE_VERSION,activityEvidence:{turnId:'a'}},
    {id:'luna',model:'gpt-5.6-luna',status:'active',startedAt:now,tokens,tokensKnown:true,
      usageCredits:l,costRateVersion:COST_RATE_VERSION,activityEvidence:{turnId:'l'}},
  ];
  const quota=used=>({id:'codex:primary',bucket:'codex',windowMinutes:10080,
    resetsAt:now+100000,usedPercent:used,remainingPercent:100-used});
  e.local(rows(0,0,0),now);e.quota(quota(10),now,'sample');
  e.local(rows(1000,0.25,0.005),now+5000);e.quota(quota(11),now+5000,'sample');
  assert.ok(Math.abs(e.state.totals.astra-50/51)<1e-10);
  assert.ok(Math.abs(e.state.totals.luna-1/51)<1e-10);
  assert.ok(Math.abs(e.state.rollingAllocations.reduce((n,a)=>n+a.percent,0)-1)<1e-10);
  assert.ok(e.state.rollingAllocations.every(a=>a.costRateVersion===COST_RATE_VERSION));
  assert.ok(e.state.costActivity.astra.length>0);
});

test('per-turn recorded costs fill a missed short turn without inventing an account charge',()=>{
  const e=new Estimator(saved());
  const row=thread('task',[turn('one',now-100000,now-50000,5,'gpt-5.6-sol'),turn('two',now-20000,now-10000,1)]);
  e.local([row],now);
  const result=e.sessions([row],now)[0];
  assert.deepEqual(result.historicalModels,['gpt-5.6-sol','gpt-5.6-luna']);
  assert.equal(result.totalEstimatedPercent,0.06);
  assert.equal(result.latestTurnEstimatedPercent,0.01);
  assert.equal(result.latestTurnSecondsPerPercent,1000);
  assert.equal(result.averageSecondsPerPercent,1000);
  assert.equal(result.estimateSource,'model-token-cost-calibrated');
  assert.equal(e.state.rollingQuotaEvents.length,0);
  const restored=new Estimator(JSON.parse(JSON.stringify(e.state)));
  assert.equal(restored.sessions([],now+1000)[0].totalEstimatedPercent,0.06);
});

test('new reconstruction replaces overlapping old estimates and preserves disjoint history',()=>{
  const e=new Estimator(saved());
  e.state.rollingAllocations=[{id:'task',at:now-110000,startAt:now-120000,endAt:now-110000,percent:2},
    {id:'task',at:now-10000,startAt:now-20000,endAt:now-10000,percent:99,turnKey:'task:1:new',turnPercent:99}];
  const row=thread('task',[turn('new',now-20000,now-10000,1)]);
  e.local([row],now);const result=e.sessions([row],now)[0];
  assert.equal(result.totalEstimatedPercent,2.01);
  assert.equal(result.latestTurnEstimatedPercent,0.01);
  assert.equal(result.estimateIncludesLegacy,true);
  assert.equal(e.state.rollingAllocations[1].percent,99);
});

test('parent cost and elapsed totals count each child once and each concurrent second once',()=>{
  const e=new Estimator(saved());
  const parent=thread('parent',[turn('p',now-60000,now,2)]);
  const child=thread('child',[turn('c',now-30000,now,1)],{parentThreadId:'parent'});
  e.local([parent,child],now);const result=e.sessions([parent,child],now)[0];
  assert.equal(result.totalEstimatedPercent,0.03);
  assert.equal(result.latestTurnEstimatedPercent,0.03);
  assert.equal(result.totalElapsedSeconds,60);
  assert.equal(result.averageSecondsPerPercent,2000);
});

test('a different account cannot reuse cost calibration from the previous account',()=>{
  const state=saved();state.accountUnit='different:codex:10080';
  state.previous={accountKey:'different',identity:'different:codex:primary:1'};
  const e=new Estimator(state);const row=thread('task',[turn('one',now-10000,now,1)]);
  e.local([row],now);assert.equal(e.sessions([row],now)[0].totalEstimatedPercent,null);
});

test('cost deltas that cross a turn boundary never attach wholly to the new turn',()=>{
  const e=new Estimator();
  const row=(id,start,tokens,cost)=>({id:'task',model:'gpt-5.6-luna',status:'active',startedAt:start,
    tokens,tokensKnown:true,usageCredits:cost,costRateVersion:COST_RATE_VERSION,activityEvidence:{turnId:id}});
  e.local([row('old',now,0,0)],now);
  e.local([row('new',now+1000,1000,0.5)],now+5000);
  assert.equal(e.state.pendingCosts.task,0.5);
  assert.equal(e.state.pendingCostTurns.task,undefined);
  e.local([row('new',now+1000,2000,1)],now+10000);
  assert.equal(e.state.pendingCostTurns.task.credits,0.5);
});

test('corrupted official split amounts cannot create a cost calibration sample',()=>{
  const e=new Estimator({...saved(),costCalibrationSamples:[]});
  e.state.rollingAllocations=[{id:'task',at:now,percent:1,costCredits:10,costRateVersion:COST_RATE_VERSION,
    attributionEventId:'bad',quotaIdentity:'sample:codex:primary:1'}];
  e.state.rollingQuotaEvents=[{id:'bad',at:now,percent:5,attributedPercent:1,unattributedPercent:0,
    coverage:'official-quota-sample',quotaIdentity:'sample:codex:primary:1'}];
  e.local([],now);
  assert.equal(e.costCalibration.sampleCount,0);
});

test('a newly created short task contributes its recorded first-turn cost exactly once',()=>{
  const e=new Estimator();e.local([],now);
  const quota=used=>({id:'codex:primary',bucket:'codex',windowMinutes:10080,resetsAt:now+100000,
    usedPercent:used,remainingPercent:100-used});
  e.quota(quota(10),now,'sample');
  const born=thread('born',[turn('first',now+1000,now+4000,0.05)],{createdAt:now+1000,usageCredits:0.05,costRateVersion:COST_RATE_VERSION});
  e.local([born],now+5000);assert.equal(e.state.pendingCosts.born,0.05);
  e.local([born],now+10000);assert.equal(e.state.pendingCosts.born,0.05);
  e.quota(quota(11),now+10000,'sample');
  assert.equal(e.state.rollingAllocations.length,1);
  assert.equal(e.state.rollingAllocations[0].costCredits,0.05);
});

test('a rollout cache replacement establishes a new cost baseline instead of recounting its history',()=>{
  const e=new Estimator();
  const row=(tokens,cost,epoch)=>({id:'task',model:'gpt-5.6-luna',status:'active',startedAt:now,
    tokens,tokensKnown:true,usageCredits:cost,costEpoch:epoch,costRateVersion:COST_RATE_VERSION,
    activityEvidence:{turnId:'same-turn'}});
  const quota=used=>({id:'codex:primary',bucket:'codex',windowMinutes:10080,resetsAt:now+100000,
    usedPercent:used,remainingPercent:100-used});
  e.local([row(0,1,'first-cache')],now);e.quota(quota(10),now,'sample');
  e.local([row(1000,100,'reloaded-cache')],now+5000);
  assert.equal(e.state.pendingCosts.task,undefined);
  e.local([row(2000,110,'reloaded-cache')],now+10000);
  assert.equal(e.state.pendingCosts.task,10);
  e.quota(quota(11),now+10000,'sample');
  assert.ok(e.state.rollingAllocations.every(event=>!event.costRateVersion));
});

test('a regressed lifecycle cannot relabel a historical average as the current turn forecast',()=>{
  const e=new Estimator({legacyAggregateMigrated:true});
  e.state.rollingAllocations=[{id:'task',at:now-10000,startAt:now-20000,endAt:now-10000,percent:1}];
  e.local([{id:'task',model:'gpt-5.6-luna',status:'active',startedAt:now,tokens:0,
    activityEvidence:{turnId:'current'}}],now);
  const old={id:'task',model:'gpt-5.6-luna',status:'idle',startedAt:now-20000,completedAt:now-10000,
    tokens:0,activityEvidence:{turnId:'older'}};
  const result=e.sessions([old],now+1000)[0];
  assert.equal(result.latestTurnElapsedSeconds,null);
  assert.equal(result.latestTurnSecondsPerPercent,null);
});

test('partial priced-token coverage cannot be presented as a complete cost-weighted account allocation',()=>{
  const e=new Estimator();
  const row=(tokens,cost,costTokens)=>({id:'task',model:'gpt-5.6-luna',status:'active',startedAt:now,
    tokens,tokensKnown:true,usageCredits:cost,costTokens,costEpoch:'stable',costRateVersion:COST_RATE_VERSION,
    activityEvidence:{turnId:'turn'}});
  const quota=used=>({id:'codex:primary',bucket:'codex',windowMinutes:10080,resetsAt:now+100000,
    usedPercent:used,remainingPercent:100-used});
  e.local([row(0,0,0)],now);e.quota(quota(10),now,'sample');
  e.local([row(2000,0.05,1000)],now+5000);e.quota(quota(11),now+5000,'sample');
  assert.ok(e.state.rollingAllocations.every(event=>!event.costRateVersion));
});
