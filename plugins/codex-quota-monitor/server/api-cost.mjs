import { tokenUsage } from './usage-cost.mjs';

// USD per million short-context tokens: ordinary input, cached input, output.
// Independent of Codex credit weights. Official table checked 2026-09-20.
export const API_PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';
export const API_PRICE_CHECKED_AT = '2026-09-20';
export const API_PRICE_VERSION = 'openai-api-usd-2026-09-20';
const standard = {
  'gpt-6-astra':[10,1,50], 'gpt-5.6-sol':[4,.4,20],
  'gpt-5.6-terra':[2,.2,12], 'gpt-5.6-luna':[.2,.02,1.2],
  'gpt-5.5':[5,.5,30], 'gpt-5.5-pro':[30,null,180],
  'gpt-5.4':[2.5,.25,15], 'gpt-5.4-mini':[.75,.075,4.5],
  'gpt-5.4-nano':[.2,.02,1.25], 'gpt-5.4-pro':[30,null,180],
  'gpt-5.3-codex':[1.75,.175,14], 'gpt-5.2':[1.75,.175,14],
  'gpt-5.2-pro':[21,null,168], 'gpt-5.1':[1.25,.125,10],
  'gpt-5':[1.25,.125,10], 'gpt-5-mini':[.25,.025,2], 'gpt-5-nano':[.05,.005,.4],
  'gpt-5-pro':[15,null,120], 'gpt-4.1':[2,.5,8], 'gpt-4.1-mini':[.4,.1,1.6],
  'gpt-4.1-nano':[.1,.025,.4], 'gpt-4o':[2.5,1.25,10], 'gpt-4o-mini':[.15,.075,.6],
  'o1':[15,7.5,60], 'o1-pro':[150,null,600], 'o3':[2,.5,8],
  'o3-pro':[20,null,80], 'o4-mini':[1.1,.275,4.4], 'o3-mini':[1.1,.55,4.4],
};
const fast = {
  'gpt-6-astra':[20,2,100], 'gpt-5.6-sol':[8,.8,40],
  'gpt-5.6-terra':[4,.4,24], 'gpt-5.6-luna':[.4,.04,2.4],
  'gpt-5.5':[12.5,1.25,75], 'gpt-5.4':[5,.5,30], 'gpt-5.4-mini':[1.5,.15,9],
  'gpt-5.3-codex':[3.5,.35,28], 'gpt-5.2':[3.5,.35,28], 'gpt-5.1':[2.5,.25,20],
  'gpt-5':[2.5,.25,20], 'gpt-5-mini':[.45,.045,3.6],
  'gpt-4.1':[3.5,.875,14], 'gpt-4.1-mini':[.7,.175,2.8], 'gpt-4.1-nano':[.2,.05,.8],
  'gpt-4o':[4.25,2.125,17], 'gpt-4o-mini':[.25,.125,1], 'o3':[3.5,.875,14], 'o4-mini':[2,.5,8],
};
const flex = {
  'gpt-6-astra':[5,.5,25], 'gpt-5.6-sol':[2,.2,10],
  'gpt-5.6-terra':[1,.1,6], 'gpt-5.6-luna':[.1,.01,.6],
  'gpt-5.5':[2.5,.25,15], 'gpt-5.5-pro':[15,null,90],
  'gpt-5.4':[1.25,.13,7.5], 'gpt-5.4-mini':[.375,.0375,2.25],
  'gpt-5.4-nano':[.1,.01,.625], 'gpt-5.4-pro':[15,null,90],
  'gpt-5.2':[.875,.0875,7], 'gpt-5.1':[.625,.0625,5],
  'gpt-5':[.625,.0625,5], 'gpt-5-mini':[.125,.0125,1], 'gpt-5-nano':[.025,.0025,.2],
  'o3':[1,.25,4], 'o4-mini':[.55,.138,2.2],
};
const rates = { standard,fast,flex };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const tierOf = value => !value || ['auto','default','standard'].includes(value) ? 'standard'
  : value === 'priority' ? 'fast' : value;
const keyOf = row => JSON.stringify([row.model || null,row.serviceTier || null]);
const emptyUsage = () => ({inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0});
const addUsage = (a,b) => { for (const key of Object.keys(a)) a[key] += b[key] || 0; return a; };
const equalUsage = (a,b) => ['inputTokens','cachedInputTokens','outputTokens'].every(key => a?.[key] === b?.[key]);
const withinUsage = (a,b) => a.inputTokens-a.cachedInputTokens <= b.inputTokens-b.cachedInputTokens &&
  a.cachedInputTokens <= b.cachedInputTokens && a.outputTokens <= b.outputTokens;

export const API_PRICING = Object.freeze({
  source:API_PRICE_SOURCE,checkedAt:API_PRICE_CHECKED_AT,version:API_PRICE_VERSION,currency:'USD',
  basis:'official-api-short-context',
  note:'按官方 API 短上下文价格折算，已知 Fast/Priority/Flex 使用对应单价，未记录档位时按 Standard。未包含缓存写入和长上下文加价、工具和地区费用及供应商差价。未分类 token 或缺少可靠模型信息的部分不计价。',
});

export function mergePricingUsage(...collections) {
  const rows = new Map();
  for (const raw of collections.flatMap(value => Array.isArray(value) ? value : [])) {
    const usage = tokenUsage(raw?.tokenUsage);
    if (!usage) continue;
    const row = {model:text(raw.model),serviceTier:text(raw.serviceTier),tokenUsage:emptyUsage()};
    const key = keyOf(row), previous = rows.get(key) || row;
    addUsage(previous.tokenUsage,usage);
    rows.set(key,previous);
  }
  return [...rows.values()];
}

export function pricingUsageTotal(rows) {
  return mergePricingUsage(rows).reduce((total,row) => addUsage(total,row.tokenUsage),emptyUsage());
}

// Keep the most complete coherent evidence for a retained cumulative turn.
export function retainPricingUsage(usage, incoming, previous) {
  const limit = tokenUsage(usage);
  if (!limit) return [];
  const candidates = [incoming,previous].map(rows => mergePricingUsage(rows))
    .filter(rows => withinUsage(pricingUsageTotal(rows),limit));
  return candidates.sort((a,b) => pricingUsageTotal(b).totalTokens-pricingUsageTotal(a).totalTokens)[0] || [];
}

export function pricingUsageDifference(current, previous) {
  if (!Array.isArray(current) || !Array.isArray(previous)) return null;
  const before = new Map(mergePricingUsage(previous).map(row => [keyOf(row),row]));
  const result = [];
  for (const row of mergePricingUsage(current)) {
    const old = before.get(keyOf(row))?.tokenUsage || emptyUsage();
    const delta = tokenUsage({ inputTokens:row.tokenUsage.inputTokens-old.inputTokens,
      cachedInputTokens:row.tokenUsage.cachedInputTokens-old.cachedInputTokens,
      outputTokens:row.tokenUsage.outputTokens-old.outputTokens });
    if (!delta) return null;
    if (delta.totalTokens) result.push({...row,tokenUsage:delta});
    before.delete(keyOf(row));
  }
  if ([...before.values()].some(row=>row.tokenUsage.totalTokens)) return null;
  return result;
}

// Old provider buckets can be repriced only when exact complete turn evidence
// proves their breakdown, or proves a single model/tier for every counted token.
export function recoverProviderPricing(usage, turn, previous) {
  const limit = tokenUsage(usage), turnUsage = tokenUsage(turn?.tokenUsage);
  const known = retainPricingUsage(usage,previous,[]);
  const rows = mergePricingUsage(turn?.pricingUsage);
  if (!limit || !turnUsage) return known;
  if (equalUsage(limit,turnUsage)) return retainPricingUsage(usage,rows,known);
  if (!equalUsage(pricingUsageTotal(rows),turnUsage)) return known;
  if (rows.length===1 && withinUsage(limit,turnUsage))
    return retainPricingUsage(usage,[{...rows[0],tokenUsage:limit}],known);
  return known;
}

export function estimateApiCost(usage, evidence) {
  const classified = tokenUsage(usage);
  const totalTokens = Number.isFinite(usage?.totalTokens) && usage.totalTokens >= 0
    ? usage.totalTokens : Number.isFinite(classified?.totalTokens) ? classified.totalTokens : 0;
  const rows = classified && Number.isFinite(classified.totalTokens) && classified.totalTokens <= totalTokens
    ? retainPricingUsage(usage,evidence,[]) : [];
  let usd=0,pricedTokens=0;
  const modelRows=[],assumptions=new Set(['短上下文基准；未计入额外费用']);
  for (const row of rows) {
    const tier = tierOf(row.serviceTier), table = Object.hasOwn(rates,tier) ? rates[tier] : null;
    const price = table && Object.hasOwn(table,row.model) ? table[row.model] : null;
    const u=row.tokenUsage;
    if (!price || (u.cachedInputTokens>0 && price[1]===null)) continue;
    const value=((u.inputTokens-u.cachedInputTokens)*price[0]+u.cachedInputTokens*(price[1]||0)+u.outputTokens*price[2])/1_000_000;
    if (!Number.isFinite(value)) continue;
    usd+=value;pricedTokens+=u.totalTokens;
    modelRows.push({model:row.model,serviceTier:tier,usd:value,tokens:u.totalTokens});
    if (!row.serviceTier || row.serviceTier==='auto') assumptions.add('未记录服务档位时按 Standard');
    if (/^gpt-(6|5\.6)/.test(row.model)) assumptions.add('未计入缓存写入加价');
  }
  const unpricedTokens=Math.max(0,totalTokens-pricedTokens);
  return {usd:pricedTokens>0?usd:null,pricedTokens,unpricedTokens,totalTokens,
    coverage:pricedTokens>0 ? unpricedTokens>0?'partial':'complete' : 'none',
    modelRows:modelRows.sort((a,b)=>b.usd-a.usd),assumptions:[...assumptions]};
}

export function mergeCostEstimates(estimates) {
  let usd=0,pricedTokens=0,totalTokens=0;
  const rows=new Map(),assumptions=new Set();
  for (const estimate of estimates) {
    if (!estimate) continue;
    usd+=estimate.usd||0;pricedTokens+=estimate.pricedTokens;totalTokens+=estimate.totalTokens;
    estimate.assumptions.forEach(value=>assumptions.add(value));
    for (const row of estimate.modelRows) {
      const key=keyOf(row),previous=rows.get(key)||{model:row.model,serviceTier:row.serviceTier,usd:0,tokens:0};
      previous.usd+=row.usd;previous.tokens+=row.tokens;rows.set(key,previous);
    }
  }
  const unpricedTokens=Math.max(0,totalTokens-pricedTokens);
  return {usd:pricedTokens>0?usd:null,pricedTokens,unpricedTokens,totalTokens,
    coverage:pricedTokens>0 ? unpricedTokens>0?'partial':'complete' : 'none',
    modelRows:[...rows.values()].sort((a,b)=>b.usd-a.usd),assumptions:[...assumptions]};
}
