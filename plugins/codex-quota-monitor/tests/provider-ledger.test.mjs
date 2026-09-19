import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderLedger,migrateProviderScope} from '../server/provider-ledger.mjs';
import {Estimator} from '../server/metrics.mjs';
import {COST_RATE_VERSION} from '../server/usage-cost.mjs';
const start=1800000000000;
const usage=(n)=>({inputTokens:n,cachedInputTokens:0,outputTokens:0,totalTokens:n});
const turn=(id,p,n,extra={})=>({turnId:id,modelProvider:p,startedAt:start,completedAt:start+1000,
  tokenUsage:usage(n),costCredits:p==='openai'?1:null,costTokens:p==='openai'?n:0,
  costRateVersion:p==='openai'?COST_RATE_VERSION:null,costCoverage:'recorded-turn',...extra});
const thread=(id,p,turns,n=100,extra={})=>({id,title:id,modelProvider:p,model:'same-model',
  status:'active',startedAt:turns.at(-1)?.startedAt || start,activityEvidence:{turnId:turns.at(-1)?.turnId || 'current'},
  tokens:n,tokensKnown:true,executionHistory:{turns},...extra});
const config={activeProvider:'muse',providers:[{id:'muse',name:'Muse Proxy'},{id:'custom',name:'My API'}]};

test('provider catalog auto-selects current API and keeps configured custom providers without exposing configuration',()=>{
  const l=new ProviderLedger();l.ingest([],start,config);
  assert.equal(l.catalog().selectedId,'muse');assert.equal(l.catalog('openai').selectedId,'openai');
  assert.equal(l.catalog().providers.find(p=>p.id==='muse').name,'Muse Proxy');
  assert.deepEqual(l.catalog().providers.map(p=>p.id),['openai','muse','custom']);
});
test('same-model uses separate provider tokens and excludes API turns from Codex input',()=>{
  const l=new ProviderLedger();l.ingest([thread('mixed','muse',[turn('old','openai',100),turn('new','muse',200,{startedAt:start+2000})])],start+4000,config);
  assert.equal(l.apiSnapshot('muse',start+4000).summary.totalTokens,200);
  assert.equal(l.codexThreads()[0].tokens,100);assert.equal(l.codexThreads()[0].status,'idle');
});
test('unproven history stays unknown while subsequent stable-provider increments count exactly once',()=>{
  const l=new ProviderLedger();
  const t=n=>thread('mixed','muse',[turn('current',null,n,{completedAt:null})],n);
  l.ingest([t(100)],start+2000,config);assert.equal(l.apiSnapshot('muse',start+2000).summary.totalTokens,0);
  l.ingest([t(150)],start+3000,config);l.ingest([t(150)],start+4000,config);
  assert.equal(l.apiSnapshot('muse',start+4000).summary.totalTokens,50);
  assert.equal(l.apiSnapshot('unknown',start+4000).summary.totalTokens,100);
  assert.equal(l.apiSnapshot('muse',start+4000).since,start+2000);
  assert.equal(l.codexThreads().length,0);
});
test('restart and provider switches reset baselines without assigning offline deltas',()=>{
  const l=new ProviderLedger();const t=(p,n)=>thread('mixed',p,[turn('current',null,n,{completedAt:null})],n);
  l.ingest([t('muse',100)],start,config);l.ingest([t('muse',120)],start+1000,config);
  const restored=new ProviderLedger(JSON.parse(JSON.stringify(l.state)));
  restored.ingest([t('muse',200)],start+5000,config);
  assert.equal(restored.apiSnapshot('muse',start+5000).summary.totalTokens,20);
  restored.ingest([t('custom',220)],start+6000,config);
  restored.ingest([t('custom',230)],start+7000,config);
  assert.equal(restored.apiSnapshot('custom',start+7000).summary.totalTokens,10);
  assert.equal(restored.apiSnapshot('muse',start+7000).summary.totalTokens,20);
});
test('provider-specific completed records replace their sampled suffix rather than doubling it',()=>{
  const l=new ProviderLedger();l.ingest([thread('a','muse',[turn('current',null,100)],100)],start+2000,config);
  l.ingest([thread('a','muse',[turn('current',null,150)],150)],start+3000,config);
  l.ingest([thread('a','muse',[turn('current','muse',150)],150)],start+4000,config);
  assert.equal(l.apiSnapshot('muse',start+4000).summary.totalTokens,150);
  assert.equal(l.apiSnapshot('unknown',start+4000).summary.totalTokens,0);
});
test('parent and child usage remains independent without duplicate family totals',()=>{
  const l=new ProviderLedger();l.ingest([thread('p','muse',[turn('p','muse',100)]),
    thread('c','muse',[turn('c','muse',30)],30,{parentThreadId:'p'})],start+2000,config);
  const a=l.apiSnapshot('muse',start+2000);assert.equal(a.summary.totalTokens,130);
  assert.equal(a.summary.taskCount,2);
});
test('legacy token records survive migration as unverified history until provenance is recovered',()=>{
  const l=new ProviderLedger();l.seedLegacy({a:{title:'a',usageTurns:[turn('old',null,300)]}});
  assert.equal(l.apiSnapshot('unknown',start+2000).summary.totalTokens,300);
  l.ingest([thread('a','muse',[turn('old','muse',300)])],start+2000,config);
  assert.equal(l.apiSnapshot('muse',start+2000).summary.totalTokens,300);
  assert.equal(l.apiSnapshot('unknown',start+2000).summary.totalTokens,0);
});
test('provider scope migration preserves official consumption and assigns unproven shares to unknown usage',()=>{
  const e=new Estimator();e.state.rollingAllocations=[
    {id:'good',turnKey:'good:1:t',percent:1,attributionEventId:'q'},
    {id:'api',turnKey:'api:1:x',percent:2,attributionEventId:'q'}];
  e.state.rollingQuotaEvents=[{id:'q',percent:3,attributedPercent:3,unattributedPercent:0,coverage:'official-quota-sample'}];
  e.state.rollingObservations=[{threadId:'good',turnKey:'good:1:t',seconds:1},
    {threadId:'api',turnKey:'api:1:x',seconds:1}];
  migrateProviderScope(e,[{id:'good',usageTurns:[turn('t','openai',100)]}]);
  assert.equal(e.state.rollingAllocations.length,1);
  assert.equal(e.state.rollingObservations.length,1);
  assert.equal(e.state.rollingQuotaEvents[0].percent,3);assert.equal(e.state.rollingQuotaEvents[0].unattributedPercent,2);
});
test('persisted confirmed prefixes survive a later ambiguous provider switch',()=>{
  const l=new ProviderLedger();
  const t=(p,proven,n)=>thread('task',p,[turn('current',proven,n,{completedAt:null})],n);
  l.ingest([t('openai','openai',100)],start,config);
  const restored=new ProviderLedger(JSON.parse(JSON.stringify(l.state)));
  restored.ingest([t('muse',null,100)],start+1000,config);
  restored.ingest([t('muse',null,120)],start+2000,config);
  assert.equal(restored.codexThreads()[0].tokens,100);
  assert.equal(restored.apiSnapshot('muse',start+2000).summary.totalTokens,20);
  assert.equal(restored.apiSnapshot('unknown',start+2000).summary.totalTokens,0);
});
test('observed OpenAI suffix contributes only its own sampled amount',()=>{
  const l=new ProviderLedger();const t=n=>thread('task','openai',[turn('current',null,n,{completedAt:null})],n);
  l.ingest([t(100)],start,config);l.ingest([t(120)],start+1000,config);
  assert.equal(l.codexThreads()[0].tokens,20);
  assert.equal(l.codexThreads()[0].status,'active');
  assert.equal(l.apiSnapshot('unknown',start+1000).summary.totalTokens,100);
});
test('full-turn duration survives monitor restarts while observed duration and tokens exclude offline gaps',()=>{
  const t=(p,n)=>thread('task',p,[turn('current',null,n,{completedAt:null})],n);
  const l=new ProviderLedger();l.ingest([t('muse',100)],start,config);
  l.ingest([t('muse',120)],start+1000,config);
  const restored=new ProviderLedger(JSON.parse(JSON.stringify(l.state)));
  restored.ingest([t('muse',200)],start+100000,config);
  restored.ingest([t('muse',210)],start+101000,config);
  const snapshot=restored.apiSnapshot('muse',start+101000);
  assert.equal(snapshot.sessions[0].totalElapsedSeconds,101);
  assert.equal(snapshot.sessions[0].observedElapsedSeconds,2);
  assert.equal(snapshot.sessions[0].totalTokens,30);
  assert.equal(snapshot.sessionCharts.task.segments.length,1);
  assert.equal(snapshot.sessionCharts.task.segments[0].durationScope,'full-turn');
});
test('a same-provider partial record does not double count its retained prefix',()=>{
  const l=new ProviderLedger();const t=(p,n)=>thread('task','muse',[turn('current',p,n,{completedAt:null,usageCoverage:'partial-turn'})],n);
  l.ingest([t('muse',100)],start,config);l.ingest([t(null,100)],start+1000,config);
  l.ingest([t('muse',150)],start+2000,config);
  assert.equal(l.apiSnapshot('muse',start+2000).summary.totalTokens,150);
});
test('Codex projected sampled intervals do not bridge offline gaps',()=>{
  const t=n=>thread('task','openai',[turn('current',null,n,{completedAt:null})],n);
  const l=new ProviderLedger();l.ingest([t(100)],start,config);l.ingest([t(120)],start+1000,config);
  const restored=new ProviderLedger(JSON.parse(JSON.stringify(l.state)));
  restored.ingest([t(200)],start+100000,config);restored.ingest([t(210)],start+101000,config);
  const history=restored.codexThreads()[0].executionHistory;
  assert.deepEqual(history.intervals,[[start,start+1000],[start+100000,start+101000]]);
});
