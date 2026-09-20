import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PRICING, estimateApiCost, mergeCostEstimates, mergePricingUsage,
  pricingUsageDifference, recoverProviderPricing } from '../server/api-cost.mjs';
import { ProviderLedger } from '../server/provider-ledger.mjs';

const usage=(inputTokens,cachedInputTokens=0,outputTokens=0,unclassifiedTokens=0)=>({
  inputTokens,cachedInputTokens,outputTokens,unclassifiedTokens,totalTokens:inputTokens+outputTokens+unclassifiedTokens,
});
const part=(model,tokenUsage,serviceTier=null)=>({model,tokenUsage,serviceTier});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('official USD pricing counts cached input once and does not reuse Codex credits',()=>{
  const u=usage(1_000_000,800_000,100_000);
  const estimate=estimateApiCost(u,[part('gpt-6-astra',u)]);
  near(estimate.usd,7.8);
  assert.equal(estimate.pricedTokens,1_100_000);
  assert.equal(estimate.coverage,'complete');
  assert.equal(API_PRICING.currency,'USD');
  assert.equal(API_PRICING.basis,'official-api-short-context');
  assert.ok(estimate.assumptions.includes('未计入缓存写入加价'));
  assert.ok(estimate.assumptions.includes('未记录服务档位时按 Standard'));
});

test('Fast and Priority use API rates, Flex uses its verified table, and unsupported tiers stay unpriced',()=>{
  const u=usage(1_000_000,0,100_000);
  for(const tier of ['fast','priority']) near(estimateApiCost(u,[part('gpt-6-astra',u,tier)]).usd,30);
  near(estimateApiCost(u,[part('gpt-6-astra',u,'flex')]).usd,7.5);
  near(estimateApiCost(u,[part('gpt-5.5',u,'fast')]).usd,20);
  assert.equal(estimateApiCost(u,[part('gpt-6-astra',u,'ultrafast')]).usd,null);
});

test('mixed models are priced independently and unknown/unclassified tokens have visible partial coverage',()=>{
  const first=usage(1_000_000),second=usage(1_000_000),unknown=usage(1000);
  const estimate=estimateApiCost(usage(2_001_000,0,0,99),[
    part('gpt-6-astra',first),part('gpt-5.6-luna',second),part('custom-model',unknown),
  ]);
  near(estimate.usd,10.2);
  assert.equal(estimate.pricedTokens,2_000_000);
  assert.equal(estimate.unpricedTokens,1099);
  assert.equal(estimate.coverage,'partial');
  const unpriced=estimateApiCost(unknown,[part('constructor',unknown)]);
  assert.equal(unpriced.usd,null);
  assert.equal(unpriced.coverage,'none');
  assert.equal(estimateApiCost(unknown,[part('gpt-6-astra',unknown,'constructor')]).usd,null);
});

test('uncoherent pricing evidence cannot exceed the counted usage or assume a model',()=>{
  const u=usage(10);
  assert.equal(estimateApiCost(u,[part('gpt-6-astra',usage(11))]).usd,null);
  assert.equal(estimateApiCost(u,[part(null,u)]).usd,null);
  assert.equal(estimateApiCost({...usage(100),totalTokens:1},[part('gpt-6-astra',usage(100))]).usd,null);
});

test('provider recovery needs complete identity evidence for a subset, or the exact counted full-turn breakdown',()=>{
  const whole=usage(200),subset=usage(100);
  const mixed={tokenUsage:whole,pricingUsage:[part('gpt-6-astra',subset),part('gpt-5.6-luna',subset)]};
  assert.deepEqual(recoverProviderPricing(subset,mixed,[]),[]);
  assert.equal(recoverProviderPricing(whole,mixed,[]).length,2);
  const stable={tokenUsage:whole,pricingUsage:[part('gpt-6-astra',whole)]};
  assert.equal(recoverProviderPricing(subset,stable,[])[0].tokenUsage.totalTokens,100);
  assert.equal(recoverProviderPricing(whole,{tokenUsage:whole,pricingUsage:[part('gpt-6-astra',subset)]},[])[0].tokenUsage.totalTokens,100);
});

test('pricing deltas track model changes and reject resets without counting duplicate snapshots',()=>{
  const before=[part('gpt-6-astra',usage(100))];
  const after=mergePricingUsage(before,[part('gpt-5.6-luna',usage(50))]);
  assert.deepEqual(pricingUsageDifference(before,before),[]);
  assert.equal(pricingUsageDifference(after,before)[0].model,'gpt-5.6-luna');
  assert.equal(pricingUsageDifference(before,after),null);
});

test('ledger reuses proven model groups for retained Muse usage and totals task/turn estimates exactly once',()=>{
  const start=1_800_000_000_000, key='id:turn';
  const saved={tasks:{p:{id:'p',title:'Parent',model:'misleading-latest-model',modelProvider:'sample-api',status:'idle',
    turns:{[key]:{turnId:'turn',startedAt:start,completedAt:start+1000,modelProvider:null,
      tokenUsage:usage(1_000_000,800_000,100_000),pricingUsage:[]}},
    observed:{[key]:{'sample-api':{...usage(1_000_000,800_000,100_000),turnId:'turn',intervals:[[start,start+1000]]}}}}}};
  const ledger=new ProviderLedger(saved);
  assert.equal(ledger.apiSnapshot('sample-api',start+2000).summary.costEstimate.usd,null);
  const t=saved.tasks.p.turns[key];t.pricingUsage=[part('gpt-6-astra',t.tokenUsage)];
  const snapshot=ledger.apiSnapshot('sample-api',start+2000);
  near(snapshot.summary.costEstimate.usd,7.8);
  near(snapshot.sessions[0].costEstimate.usd,7.8);
  near(snapshot.sessionCharts.p.segments[0].costEstimate.usd,7.8);
  assert.equal(snapshot.summary.totalTokens,1_100_000);
  assert.equal(ledger.apiSnapshot('unknown',start+2000).summary.totalTokens,0);
});

test('new sampled model groups persist across restart without assigning offline token deltas',()=>{
  const start=1_800_000_000_000,config={activeProvider:'sample-api',providers:[]};
  const item=(amount,groups)=>({id:'task',model:'wrong-model',modelProvider:'sample-api',status:'active',
    startedAt:start,tokens:amount,tokensKnown:true,activityEvidence:{turnId:'turn'},executionHistory:{turns:[{
      turnId:'turn',startedAt:start,completedAt:null,modelProvider:null,tokenUsage:usage(amount),pricingUsage:groups,
    }]}});
  const ledger=new ProviderLedger();
  ledger.ingest([item(100,[part('gpt-6-astra',usage(100))])],start,config);
  ledger.ingest([item(150,[part('gpt-6-astra',usage(100)),part('gpt-5.6-luna',usage(50))])],start+1000,config);
  let snapshot=ledger.apiSnapshot('sample-api',start+1000);
  near(snapshot.summary.costEstimate.usd,.00001);
  assert.equal(snapshot.summary.costEstimate.pricedTokens,50);
  const restored=new ProviderLedger(structuredClone(ledger.state));
  restored.ingest([item(200,[part('gpt-6-astra',usage(100)),part('gpt-5.6-luna',usage(100))])],start+100_000,config);
  snapshot=restored.apiSnapshot('sample-api',start+100_000);
  assert.equal(snapshot.summary.totalTokens,50);
  near(snapshot.summary.costEstimate.usd,.00001);
});

test('cost summary preserves partial estimates and unknown amounts rather than turning them into zero',()=>{
  const known=estimateApiCost(usage(100),[part('gpt-6-astra',usage(100))]);
  const unknown=estimateApiCost(usage(20),[]);
  const total=mergeCostEstimates([known,unknown]);
  near(total.usd,.001);
  assert.equal(total.totalTokens,120);
  assert.equal(total.unpricedTokens,20);
  assert.equal(total.coverage,'partial');
  assert.equal(mergeCostEstimates([unknown]).usd,null);
});
