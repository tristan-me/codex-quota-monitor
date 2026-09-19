import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Collector,validateSettings} from '../server/collector.mjs';

test('monitor source selection persists without model writes or account contamination',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'provider-collector-'));let writes=0;
  const now=Date.now();const reader={read:()=>({providerConfig:{activeProvider:'muse',providers:[{id:'muse',name:'Muse'},{id:'my-api',name:'My API'}]},diagnostics:{},threads:[{
    id:'synthetic-api-task',modelProvider:'muse',status:'idle',startedAt:now-2000,completedAt:now-1000,tokens:100,tokensKnown:true,
    executionHistory:{turns:[{turnId:'one',modelProvider:'muse',startedAt:now-2000,completedAt:now-1000,model:'same-name',usageCoverage:'recorded-turn',tokenUsage:{inputTokens:90,cachedInputTokens:50,outputTokens:10}}]},activityEvidence:{turnId:'one'}}]})};
  const client={request:()=>new Promise(()=>{}),close:async()=>{},writeDefaults:async()=>{writes++;}};
  const c=new Collector({dataDir,reader,client,resetFetcher:null});
  try{
    c.settings.paused=true;await c.local();
    assert.equal(c.snapshot().providerSelection.selectedId,'muse');assert.equal(c.snapshot().apiUsage.summary.totalTokens,100);
    assert.equal(c.threads.length,0);
    const codex=await c.update({selectedProvider:'openai'});
    assert.equal(codex.providerSelection.selectedId,'openai');assert.equal(codex.sessions.length,0);
    const custom=await c.update({selectedProvider:'my-api'});
    assert.equal(custom.apiUsage.summary.totalTokens,0);
    await assert.rejects(c.update({selectedProvider:'not-configured'}),/not configured/);
    await assert.rejects(c.update({autoSwitch:true}),/API/);
    assert.equal(writes,0);
    const saved=JSON.parse(await readFile(join(dataDir,'state.json'),'utf8'));
    assert.equal(saved.settings.selectedProvider,'my-api');assert.ok(saved.providerLedger.tasks['synthetic-api-task']);
  }finally{await c.close();await rm(dataDir,{recursive:true,force:true});}
});
test('monitor provider identifiers accept names but reject URL and credential-shaped settings',()=>{
  assert.equal(validateSettings({selectedProvider:'my-api'}).selectedProvider,'my-api');
  for(const value of ['https://example.invalid','a/b','',{},'muse?api_key=secret']) assert.throws(()=>validateSettings({selectedProvider:value}));
});
