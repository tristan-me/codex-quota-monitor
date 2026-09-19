import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderLedger } from '../server/provider-ledger.mjs';
import { createSessionRuntimeAxis } from '../web/usage-charts.mjs';

const start = 1_800_000_000_000;
const key = 'id:sample-turn';
const usage = totalTokens => ({ inputTokens:totalTokens,cachedInputTokens:0,outputTokens:0,totalTokens,unclassifiedTokens:0 });
function savedTask({ completedAt = start + 392_000, status = 'idle', providers, prefixes = {} } = {}) {
  return { version:1,tasks:{ sample:{ id:'sample',title:'Synthetic task',modelProvider:'sample-api',status,
    currentKey:key,startedAt:start,completedAt,lastSeenAt:start+500_000,
    turns:{ [key]:{ turnId:'sample-turn',startedAt:start,completedAt,status,modelProvider:null,
      providerSource:'conflicting-thread-metadata',tokenUsage:usage(1000),partial:false } },
    observed:{ [key]:providers || { 'sample-api':{ ...usage(1000),turnId:'sample-turn',startedAt:start,
      since:start+5000,until:start+390_000,
      intervals:Array.from({length:17},(_,i)=>[start+5000+i*20_000,start+10_000+i*20_000]) } } },
    prefixes:{ [key]:prefixes },
  } } };
}

test('retained polling windows become one full execution without changing provider tokens', () => {
  const saved=savedTask(), original=structuredClone(saved), ledger=new ProviderLedger(saved);
  const snapshot=ledger.apiSnapshot('sample-api',start+500_000);
  const row=snapshot.sessions[0], chart=snapshot.sessionCharts.sample;
  assert.equal(row.totalTokens,1000);
  assert.equal(row.turnCount,1);
  assert.equal(row.totalElapsedSeconds,392);
  assert.equal(row.observedElapsedSeconds,85);
  assert.equal(chart.segments.length,1);
  assert.equal(chart.segments[0].elapsedSeconds,392);
  assert.equal(chart.segments[0].startedAt,start);
  assert.equal(chart.segments[0].completedAt,start+392_000);
  assert.equal(chart.segments[0].durationScope,'full-turn');
  assert.equal(chart.segments[0].usageScope,'provider-observed');
  assert.equal(chart.totalAmount,1000);
  assert.equal(ledger.apiSnapshot('unknown',start+500_000).summary.totalTokens,0);
  assert.deepEqual(saved,original,'snapshot recovery must not rewrite recorded history');
});

test('a running logical turn keeps one live duration through polls with no new tokens', () => {
  const ledger=new ProviderLedger(savedTask({completedAt:null,status:'active'}));
  const first=ledger.apiSnapshot('sample-api',start+400_000);
  const later=ledger.apiSnapshot('sample-api',start+450_000);
  assert.equal(later.sessionCharts.sample.segments.length,1);
  assert.equal(later.sessionCharts.sample.segments[0].completedAt,null);
  assert.equal(later.sessionCharts.sample.segments[0].elapsedSeconds,450);
  assert.equal(first.sessionCharts.sample.segments[0].elapsedSeconds,400);
  assert.equal(later.summary.totalTokens,first.summary.totalTokens);
});

test('missing lifecycle end remains partial and uses only observation spans without inventing completion', () => {
  const spans=[[start,start+1000],[start+100_000,start+101_000]];
  const ledger=new ProviderLedger(savedTask({completedAt:null,status:'unknown',providers:{
    'sample-api':{ ...usage(100),turnId:'sample-turn',since:start,until:start+101_000,intervals:spans },
  }}));
  const snapshot=ledger.apiSnapshot('sample-api',start+500_000);
  const segment=snapshot.sessionCharts.sample.segments[0];
  assert.equal(snapshot.sessions[0].totalElapsedSeconds,2);
  assert.equal(snapshot.sessions[0].durationScope,'partial');
  assert.equal(segment.durationScope,'observed-intervals');
  assert.equal(segment.completedAt,null);
  assert.equal(segment.elapsedSeconds,2);
  assert.deepEqual(segment.runningIntervals,spans);
  assert.equal(createSessionRuntimeAxis(segment.runningIntervals).durationMs,2000);
  assert.equal(segment.points.find(p=>p.at===start+1000).value,50);
  assert.equal(segment.points.find(p=>p.at===start+100_000).value,50);
  assert.equal(segment.points.at(-1).value,100);
});

test('provider pieces share whole-turn duration while tokens remain separated and each turn appears once', () => {
  const providers={
    'sample-api':{...usage(250),turnId:'sample-turn',intervals:[[start+100_000,start+105_000]]},
    'second-api':{...usage(300),turnId:'sample-turn',intervals:[[start+200_000,start+205_000]]},
  };
  const prefixes={'sample-api':{tokenUsage:usage(100),turnId:'sample-turn',startedAt:start,completedAt:start+1000}};
  const ledger=new ProviderLedger(savedTask({providers,prefixes}));
  const first=ledger.apiSnapshot('sample-api',start+500_000), second=ledger.apiSnapshot('second-api',start+500_000);
  const unknown=ledger.apiSnapshot('unknown',start+500_000);
  assert.equal(first.sessionCharts.sample.segments.length,1);
  assert.equal(first.sessionCharts.sample.segments[0].amount,350);
  assert.equal(first.sessions[0].totalElapsedSeconds,392);
  assert.equal(second.sessions[0].totalElapsedSeconds,392);
  assert.equal(first.summary.totalTokens+second.summary.totalTokens+unknown.summary.totalTokens,1000);
});

test('terminal duration metadata recovers either missing endpoint and preserves the recorded elapsed value', () => {
  for (const missing of ['startedAt','completedAt']) {
    const turn={turnId:'duration-turn',startedAt:start,completedAt:start+390_000,durationMs:390_000,
      status:'idle',modelProvider:'sample-api',tokenUsage:usage(100)};
    turn[missing]=null;
    const ledger=new ProviderLedger();
    ledger.ingest([{id:'sample',title:'Synthetic task',status:'idle',modelProvider:'sample-api',
      activityEvidence:{turnId:turn.turnId},executionHistory:{turns:[turn]}}],start+400_000);
    const segment=ledger.apiSnapshot('sample-api',start+400_000).sessionCharts.sample.segments[0];
    assert.equal(segment.startedAt,start,missing);
    assert.equal(segment.completedAt,start+390_000,missing);
    assert.equal(segment.elapsedSeconds,390,missing);
  }
  const saved=savedTask();
  saved.tasks.sample.turns[key].durationMs=392_027;
  assert.equal(new ProviderLedger(saved).apiSnapshot('sample-api',start+500_000).sessionCharts.sample.segments[0].elapsedSeconds,392.027);
});
