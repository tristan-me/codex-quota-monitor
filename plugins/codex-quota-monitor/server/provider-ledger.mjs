import { tokenUsage, usageDifference } from './usage-cost.mjs';
import { buildSessionSegments } from './chart-data.mjs';

export const normalizeProvider = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)
  ? value.toLowerCase() === 'openai' ? 'openai' : value : null;
const turnKey = turn => turn.turnId ? `id:${turn.turnId}` : `start:${turn.startedAt}`;
const currentKey = thread => turnKey({ turnId: thread.activityEvidence?.turnId, startedAt: thread.startedAt });
const empty = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, unclassifiedTokens: 0 });
const add = (to, usage) => { for (const key of Object.keys(empty())) to[key] += usage?.[key] || 0; return to; };
const intervalSeconds = intervals => {
  let end = -Infinity, result = 0;
  for (const [a,b] of intervals.filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a,b)=>a[0]-b[0])) {
    result += Math.max(0,b-Math.max(a,end))/1000; end=Math.max(end,b);
  }
  return result;
};

export class ProviderLedger {
  constructor(saved = {}) {
    this.state = { version: 1, tasks: {}, ...saved };
    this.baselines = new Map();
    this.config = { activeProvider: null, providers: [] };
  }

  seedLegacy(knownThreads = {}) {
    if (this.state.legacyImported) return;
    for (const [id,thread] of Object.entries(knownThreads)) {
      const turns={};
      for(const turn of thread.usageTurns || []) {
        const usage=tokenUsage(turn.tokenUsage);
        if(!usage || !Number.isFinite(turn.startedAt)) continue;
        turns[turnKey(turn)]={turnId:turn.turnId,startedAt:turn.startedAt,completedAt:turn.completedAt,
          model:turn.model,reasoningEffort:turn.reasoningEffort,modelProvider:null,
          providerSource:'legacy-unverified',tokenUsage:usage,partial:turn.costCoverage==='partial-turn'};
      }
      if(Object.keys(turns).length && !this.state.tasks[id]) this.state.tasks[id]={
        id,title:thread.title||id,model:thread.model,reasoningEffort:thread.reasoningEffort,
        modelProvider:null,status:'unknown',startedAt:thread.startedAt,completedAt:thread.completedAt,
        lastSeenAt:thread.lastMetadataAt,turns,observed:{}};
    }
    this.state.legacyImported=true;
  }

  ingest(threads, now, config, maxGapMs = 15000) {
    if (config) this.config = config;
    const present = new Set();
    for (const thread of threads) {
      present.add(thread.id);
      const task = this.state.tasks[thread.id] ||= { turns: {}, observed: {} };
      task.prefixes ||= {};
      Object.assign(task, { id: thread.id, title: thread.title || thread.id,
        model: thread.model, reasoningEffort: thread.reasoningEffort,
        modelProvider: normalizeProvider(thread.modelProvider), parentThreadId: thread.parentThreadId,
        status: thread.status, startedAt: thread.startedAt, completedAt: thread.completedAt,
        currentKey: currentKey(thread), lastSeenAt: now });
      for (const turn of [...(thread.usageTurns || []), ...(thread.executionHistory?.turns || [])]) {
        if (!Number.isFinite(turn.startedAt)) continue;
        const key = turnKey(turn), old = task.turns[key];
        const usage = tokenUsage(turn.tokenUsage);
        const provider = normalizeProvider(turn.modelProvider);
        if (old?.modelProvider && !provider && old.tokenUsage &&
            (!usage || usage.totalTokens >= old.tokenUsage.totalTokens)) {
          const prefixes=task.prefixes[key] ||= {};
          const previous=Object.hasOwn(prefixes,old.modelProvider)?prefixes[old.modelProvider]:null;
          if(!previous || previous.tokenUsage.totalTokens < old.tokenUsage.totalTokens)
            prefixes[old.modelProvider]={...old,completedAt:old.completedAt ?? now,partial:true};
        }
        if (old?.tokenUsage?.totalTokens > (usage?.totalTokens || 0)) {
          task.turns[key] = { ...old, completedAt: turn.completedAt ?? old.completedAt };
          continue;
        }
        task.turns[key] = { turnId: turn.turnId, startedAt: turn.startedAt, completedAt: turn.completedAt,
          model: turn.model, reasoningEffort: turn.reasoningEffort, modelProvider: provider,
          providerSource: turn.providerSource, tokenUsage: usage || old?.tokenUsage || null,
          serviceTier: turn.serviceTier, costCredits: provider === 'openai' ? turn.costCredits : null,
          costTokens: provider === 'openai' ? turn.costTokens : 0,
          costRateVersion: provider === 'openai' ? turn.costRateVersion : null,
          costCoverage: turn.costCoverage, partial: (turn.usageCoverage ?? turn.costCoverage) === 'partial-turn' || !usage };
        // Complete provider-specific records supersede sampled increments.
        if (provider && usage && !task.turns[key].partial) delete task.observed[key];
        if (provider && usage && !task.turns[key].partial) delete task.prefixes[key];
      }
      const key = currentKey(thread), latest = task.turns[key];
      const baseline = this.baselines.get(thread.id);
      const total = Number.isFinite(thread.tokens) && thread.tokensKnown !== false ? thread.tokens : null;
      const provider = task.modelProvider;
      if ((!latest?.modelProvider || latest.partial) && provider && total !== null && baseline &&
          baseline.key === key && baseline.provider === provider && now >= baseline.at &&
          now - baseline.at <= maxGapMs && total >= baseline.total && baseline.total !== null) {
        const delta = total - baseline.total;
        const split = usageDifference(latest?.tokenUsage, baseline.usage);
        if (delta > 0) {
          const bucketKey = provider;
          const observed = task.observed[key] ||= {};
          if(!Object.hasOwn(observed,bucketKey)) Object.defineProperty(observed,bucketKey,{value:{ ...empty(), provider, since: baseline.at,
            until: now, intervals:[],turnId: thread.activityEvidence?.turnId, startedAt: thread.startedAt },enumerable:true,writable:true,configurable:true});
          const bucket = observed[bucketKey];
          const pricedSplit = split && split.totalTokens === delta ? split : null;
          add(bucket, pricedSplit || { totalTokens: delta, unclassifiedTokens: delta });
          bucket.until = now;
          bucket.intervals ||= [];
          const last=bucket.intervals.at(-1);
          if(last && last[1]===baseline.at) last[1]=now;
          else bucket.intervals.push([baseline.at,now]);
        }
      }
      this.baselines.set(thread.id, { key, provider, total, at: now, usage: latest?.tokenUsage });
    }
    for (const [id,task] of Object.entries(this.state.tasks)) {
      if (!present.has(id) && task.status === 'active') task.status = 'unknown';
      // The bounded local reader retains at most 5000 executions per task.
      const entries = Object.entries(task.turns).sort((a,b)=>a[1].startedAt-b[1].startedAt);
      for (const [key] of entries.slice(0,-5000)) { delete task.turns[key]; delete task.observed[key]; delete task.prefixes?.[key]; }
    }
  }

  catalog(selectedId = null) {
    const found = new Map([['openai',{id:'openai',name:'Codex 账号',kind:'codex'}]]);
    const append = (id,name) => { id=normalizeProvider(id); if (id && id !== 'openai') found.set(id,{id,
      name: typeof name === 'string' && name.trim() ? name.slice(0,100) : id === 'muse' ? 'Muse' : id, kind:'api'}); };
    for (const item of this.config.providers || []) append(item.id,item.name);
    if (!found.has(this.config.activeProvider)) append(this.config.activeProvider);
    for (const task of Object.values(this.state.tasks)) {
      if (!found.has(task.modelProvider)) append(task.modelProvider);
      for (const turn of Object.values(task.turns)) if (!found.has(turn.modelProvider)) append(turn.modelProvider);
    }
    if (Object.values(this.state.tasks).some(task=>Object.values(task.turns).some(turn=>!turn.modelProvider && turn.tokenUsage?.totalTokens > 0)))
      found.set('unknown',{id:'unknown',name:'历史归属不明',kind:'unknown'});
    const activeId = normalizeProvider(this.config.activeProvider) || 'openai';
    return { providers:[...found.values()], activeId,
      selectedId:found.has(selectedId) ? selectedId : found.has(activeId) ? activeId : 'openai' };
  }

  apiSnapshot(providerId,now) {
    const sessions=[],sessionCharts={};
    for (const task of Object.values(this.state.tasks)) {
      const usage=empty(), intervals=[], counted=new Set(),segments=[]; let partial=false;
      for (const [key,turn] of Object.entries(task.turns)) {
        if ((turn.modelProvider || 'unknown') !== providerId || !turn.tokenUsage) continue;
        const observed = [...Object.values(task.observed[key] || {}),
          ...Object.values(task.prefixes?.[key] || {}).map(p=>p.tokenUsage)];
        // Unknown full-turn usage includes the sampled suffix; remove that
        // suffix from its total so provider views never double count it.
        let amount=turn.tokenUsage.totalTokens;
        if (providerId === 'unknown' && observed.length) {
          const rest=Math.max(0,turn.tokenUsage.totalTokens-observed.reduce((n,v)=>n+v.totalTokens,0));
          if (!rest) continue;
          amount=rest;
          add(usage,{totalTokens:rest,unclassifiedTokens:rest});
        } else add(usage,turn.tokenUsage);
        counted.add(key); partial ||= turn.partial;
        const end=turn.completedAt ?? (task.status === 'active' ? now : task.lastSeenAt);
        intervals.push([turn.startedAt,end]);
        segments.push({id:`${task.id}:${key}`,turnId:turn.turnId,taskId:task.id,title:task.title,
          startedAt:turn.startedAt,completedAt:end,elapsedSeconds:Math.max(0,(end-turn.startedAt)/1000),amount,
          estimated:true,interpolation:'linear'});
      }
      for(const [key,byProvider] of Object.entries(task.prefixes || {})) {
        const prefix=byProvider[providerId];if(!prefix) continue;
        if(task.turns[key]?.modelProvider===providerId && task.turns[key]?.tokenUsage) continue;
        add(usage,prefix.tokenUsage);counted.add(key);partial=true;
        intervals.push([prefix.startedAt,prefix.completedAt]);
        segments.push({id:`${task.id}:${key}:prefix`,turnId:prefix.turnId,taskId:task.id,title:task.title,
          startedAt:prefix.startedAt,completedAt:prefix.completedAt,elapsedSeconds:(prefix.completedAt-prefix.startedAt)/1000,
          amount:prefix.tokenUsage.totalTokens,estimated:true,interpolation:'linear'});
      }
      for (const [key,byProvider] of Object.entries(task.observed)) {
        const bucket=byProvider[providerId]; if(!bucket) continue;
        // Partial same-provider records already contain their own sampled suffix.
        if (task.turns[key]?.modelProvider === providerId && task.turns[key]?.tokenUsage) continue;
        add(usage,bucket);counted.add(key);partial=true;intervals.push(...(bucket.intervals || []));
        const spans=bucket.intervals || [],seconds=intervalSeconds(spans);
        spans.forEach(([a,b],i)=>segments.push({id:`${task.id}:${key}:observed:${i}`,turnId:bucket.turnId,
          taskId:task.id,title:task.title,startedAt:a,completedAt:b,elapsedSeconds:(b-a)/1000,
          amount:seconds>0?bucket.totalTokens*(b-a)/1000/seconds:0,estimated:true,interpolation:'linear'}));
      }
      const current=task.modelProvider === providerId;
      if (!counted.size && !current) continue;
      sessionCharts[task.id]=buildSessionSegments(segments,{unit:'tokens',now,partial});
      sessions.push({ id:task.id,title:task.title,parentThreadId:task.parentThreadId || null,model:task.model,reasoningEffort:task.reasoningEffort,
        status:current ? task.status : 'idle',startedAt:task.startedAt,completedAt:task.completedAt,
        totalElapsedSeconds:intervalSeconds(intervals), ...usage, turnCount:counted.size,
        partial:partial || !counted.size,children:[] });
    }
    sessions.sort((a,b)=>Number(b.status==='active')-Number(a.status==='active') || (b.startedAt||0)-(a.startedAt||0));
    const summary=sessions.reduce((sum,row)=>add(sum,row),empty());
    Object.assign(summary,{taskCount:sessions.length,activeTaskCount:sessions.filter(s=>s.status==='active').length,
      turnCount:sessions.reduce((n,s)=>n+s.turnCount,0),unpricedTurnCount:sessions.reduce((n,s)=>n+s.turnCount,0)});
    return {providerId,providerName:this.catalog(providerId).providers.find(p=>p.id===providerId)?.name || providerId,
      summary,sessions,sessionCharts,since:Math.min(now,...Object.values(this.state.tasks).flatMap(t=>[
        ...Object.values(t.turns).filter(turn=>(turn.modelProvider||'unknown')===providerId).map(turn=>turn.startedAt),
        ...Object.values(t.observed).flatMap(group=>group[providerId]?[group[providerId].since]:[]),
        ...Object.values(t.prefixes || {}).flatMap(group=>group[providerId]?[group[providerId].startedAt]:[])])),until:now,
      note:'仅统计本机可读取和已保留的用量；API 金额、余额和限额尚无可信供应商数据。任务切换供应商时，无法确认的历史单列；后续连续采样增量按当时供应商归属并标记部分记录。各任务独立计数，父任务不重复累加子任务。未分类 token 已计入总量，但未列入输入/输出拆分。'};
  }

  codexThreads() {
    const result=[];
    for (const task of Object.values(this.state.tasks)) {
      const turns=Object.values(task.turns).filter(t=>t.modelProvider==='openai');
      for(const [key,byProvider] of Object.entries(task.prefixes || {})) {
        const prefix=byProvider.openai;
        if(prefix && task.turns[key]?.modelProvider!=='openai') turns.push({...prefix,turnId:`${prefix.turnId}:provider-prefix`,costCoverage:'partial-turn'});
      }
      for(const [key,byProvider] of Object.entries(task.observed)) {
        const bucket=byProvider.openai;if(!bucket || task.turns[key]?.modelProvider==='openai') continue;
        turns.push({turnId:`${bucket.turnId}:provider-observed`,startedAt:bucket.since,
          completedAt:bucket.until,measuredIntervals:bucket.intervals || [],
          model:task.model,reasoningEffort:task.reasoningEffort,modelProvider:'openai',
          tokenUsage:{...bucket},costCredits:null,costTokens:0,costCoverage:'partial-turn',partial:true});
      }
      turns.sort((a,b)=>a.startedAt-b.startedAt);
      if(!turns.length) continue;
      const latest=turns.at(-1), current=task.modelProvider==='openai' &&
        (task.currentKey===turnKey(latest) || latest.turnId?.endsWith(':provider-observed'));
      result.push({id:task.id,title:task.title,parentThreadId:task.parentThreadId,model:latest.model,
        reasoningEffort:latest.reasoningEffort,modelProvider:'openai',
        status:current ? task.status : Number.isFinite(latest.completedAt) ? 'idle':'unknown',
        startedAt:latest.measuredIntervals ? task.lastSeenAt : latest.startedAt,completedAt:latest.completedAt,updatedAt:task.lastSeenAt,
        tokens:turns.reduce((n,t)=>n+(t.tokenUsage?.totalTokens||0),0),tokensKnown:turns.some(t=>t.tokenUsage),
        usageCredits:turns.reduce((n,t)=>n+(t.costCredits||0),0),costTokens:turns.reduce((n,t)=>n+(t.costTokens||0),0),
        costRateVersion:latest.costRateVersion,costEpoch:'provider-openai',
        usageTurns:turns,activityEvidence:{turnId:latest.turnId},
        executionHistory:{turns:turns.flatMap(t=>t.measuredIntervals ? t.measuredIntervals.map(([a,b],i)=>({
            ...t,turnId:`${t.turnId}:${i}`,startedAt:a,completedAt:b})) : [t]),
          intervals:turns.flatMap(t=>t.measuredIntervals || (Number.isFinite(t.completedAt)?[[t.startedAt,t.completedAt]]:[])),
          coverage:turns.some(t=>t.partial)?'partial':'local-records',source:'provider-records'}});
    }
    const ids=new Set(result.map(t=>t.id));
    return result.map(t=>({...t,parentThreadId:ids.has(t.parentThreadId)?t.parentThreadId:null}));
  }
}

// Re-evaluate old allocations only where recorded execution provenance proves
// they belong to OpenAI. Account changes remain intact; unmatched amounts become
// unattributed. The source file is backed up by the collector before migration.
export function migrateProviderScope(estimator,threads) {
  const s=estimator.state; if(s.providerScopedVersion===1) return;
  const byId=new Map(threads.map(t=>[t.id,t]));
  const matches=event=>{
    const turns=byId.get(event.id ?? event.threadId)?.usageTurns || [];
    if(event.turnKey) return turns.some(t=>t.turnId && event.turnKey.endsWith(`:${t.turnId}`));
    return Number.isFinite(event.startAt) && Number.isFinite(event.endAt) &&
      turns.some(t=>t.startedAt<=event.startAt && Number.isFinite(t.completedAt) && t.completedAt>=event.endAt);
  };
  s.rollingAllocations=s.rollingAllocations.filter(matches);
  for(const event of s.rollingQuotaEvents) {
    if(event.coverage!=='official-quota-sample' || !Number.isFinite(event.percent)) continue;
    event.attributedPercent=Math.min(event.percent,s.rollingAllocations.filter(a=>a.attributionEventId===event.id).reduce((n,a)=>n+a.percent,0));
    event.unattributedPercent=event.percent-event.attributedPercent;
  }
  s.rollingObservations=s.rollingObservations.filter(matches);
  s.costCalibrationSamples=[];s.rollingCompletionEstimates=[];
  for(const key of ['knownThreads','sessionLedger','latestTurns','totals','groupObservationSeconds','pending','pendingCosts','pendingCostTokens','pendingCostIncomplete','pendingCostTurns','pendingTurns','pendingRanges','pendingTurnRanges','activity','costActivity','lastTokens']) s[key]={};
  s.gap=true;s.providerScopedVersion=1;
}
