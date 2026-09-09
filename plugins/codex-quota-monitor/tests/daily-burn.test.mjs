import test from 'node:test';
import assert from 'node:assert/strict';
import {Estimator} from '../server/metrics.mjs';
import {Collector} from '../server/collector.mjs';
const now=1_800_000_000_000, hour=3600000;
const quota=(used,reset=now+7*24*hour)=>({id:'codex:primary',bucket:'codex',label:'weekly',windowMinutes:10080,usedPercent:used,remainingPercent:100-used,resetsAt:reset});
function day(){const e=new Estimator();e.quota(quota(80),now-24*hour,'example');e.quota(quota(90),now-12*hour,'example');e.quota(quota(0,now+8*24*hour),now-6*hour,'example');e.quota(quota(20,now+8*24*hour),now,'example');return e;}

test('daily consumption sums charges across resets without treating the top-up as negative usage',()=>{
 const burn=day().dailyAccountBurn(now);
 assert.equal(burn.observedPercent,30);assert.equal(burn.coverageSeconds,24*3600);
 assert.equal(burn.percentPerHour,1.25);assert.equal(burn.partial,false);
});

test('a longer configured retention window never expands the day used for depletion',()=>{
 const e=new Estimator();e.setRetentionHours(72,now-48*hour);
 e.quota(quota(10),now-48*hour,'example');e.quota(quota(80),now-30*hour,'example');
 e.quota(quota(80),now-24*hour,'example');e.quota(quota(90),now,'example');
 const burn=e.dailyAccountBurn(now);assert.equal(burn.observedPercent,10);assert.equal(burn.coverageSeconds,24*3600);
 assert.equal(burn.percentPerHour,10/24);
});

test('short or incomplete history reports its effective time coverage',()=>{
 const e=new Estimator();e.quota(quota(10),now-2*hour,'example');e.quota(quota(12),now,'example');
 let burn=e.dailyAccountBurn(now);assert.equal(burn.coverageSeconds,2*3600);assert.equal(burn.percentPerHour,1);assert.equal(burn.partial,true);
 e.state.rollingQuotaEvents.unshift({at:now-hour,percent:1,coverage:'recovered-attributed-lower-bound',attributedPercent:1,unattributedPercent:0});
 burn=e.dailyAccountBurn(now);assert.equal(burn.excludedIncompleteHistory,true);assert.equal(burn.percentPerHour,null);
});

test('depletion uses the daily account average regardless of an instantaneous task spike',t=>{
 t.mock.method(Date,'now',()=>now);
 const c=new Collector({client:{},resetFetcher:null});c.estimator=day();
 c.account={windows:[quota(20,now+8*24*hour)],lastFetchedAt:now,error:null};
 c.estimator.sessions=()=>[{id:'example-task',status:'active',secondsPerPercent:1,totalEstimatedPercent:1,children:[]}];
 const reset=c.snapshot().reset;
 assert.equal(reset.exhaustionAt,now+64*hour);
 assert.equal(reset.exhaustionBasis.source,'official-account-24h-average');
 assert.equal(reset.observedAt,now);
 c.account.windows=[quota(20,now+9*24*hour)];
 assert.equal(c.snapshot().reset.scheduledAt,now+9*24*hour);
 c.account.error='offline';assert.equal(c.snapshot().reset.scheduledAt,null);assert.equal(c.snapshot().reset.exhaustionAt,null);
});

test('no observed daily consumption leaves depletion unavailable',t=>{
 t.mock.method(Date,'now',()=>now);
 const c=new Collector({client:{},resetFetcher:null});
 c.account={windows:[quota(10)],lastFetchedAt:now,error:null};
 c.estimator.quota(quota(10),now-hour,'example');c.estimator.quota(quota(10),now,'example');
 assert.equal(c.snapshot().reset.exhaustionAt,null);
});
