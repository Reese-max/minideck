import assert from 'node:assert/strict';
import test from 'node:test';
import {runIdentity,validateAdmission,immutableOrigin,parsePreview,ensureCleanupWindow} from './contract.mjs';
const sha='a'.repeat(40),id=runIdentity('12345678','1');
const env={GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'Reese-max/minideck',GITHUB_ACTOR:'Reese-max',GITHUB_TRIGGERING_ACTOR:'Reese-max',GITHUB_RUN_ID:'12345678',GITHUB_RUN_ATTEMPT:'1'};
const pr={number:44,state:'open',draft:true,user:{login:'Reese-max'},head:{sha,ref:'feature/fix-new-issues-38-41',repo:{full_name:'Reese-max/minideck'}},base:{ref:'main'}};
test('only exact same-owner same-repo open draftPR44 head is admitted',()=>{
  assert.equal(validateAdmission(env,{pull_request:pr},pr,sha).scope,id.scope);
  for(const patch of [{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_ACTOR:'other'},{GITHUB_TRIGGERING_ACTOR:'other'},{GITHUB_REPOSITORY:'other/repo'}])assert.throws(()=>validateAdmission({...env,...patch},{pull_request:pr},pr,sha));
  for(const change of [p=>p.draft=false,p=>p.number=1,p=>p.state='closed',p=>p.head.sha='b'.repeat(40),p=>p.head.repo.full_name='fork/repo',p=>p.user.login='other',p=>p.head.ref='main']){
    const copy=structuredClone(pr);change(copy);assert.throws(()=>validateAdmission(env,{pull_request:pr},copy,sha));}
});
test('run scopes are valid and attempts never reuse namespace',()=>{assert.match(id.scope,/^minideck-qa-[a-f0-9]{12}$/);assert.notEqual(runIdentity('12345678','2').scope,id.scope);for(const value of ['../x','0','1-2'])assert.throws(()=>runIdentity(value,'1'));});
test('slow setup or expired/future job stamp refuses new writes while full cleanup reserve remains',()=>{
  const start=1000000;assert.equal(ensureCleanupWindow({MINIDECK_QA_JOB_STARTED_AT:String(start)},start+5*60000).cleanupReserveMs,240000);
  for(const [value,now]of [[String(start),start+7*60000],['',start],[String(start+1),start],['not-a-time',start]])assert.throws(()=>ensureCleanupWindow({MINIDECK_QA_JOB_STARTED_AT:value},now));
});
test('only immutable upload-context URL is accepted, never alias or foreign account/worker',()=>{
  const deployment='12345678-1234-4123-8123-123456789abc',origin=`https://12345678-${id.site}.owned.workers.dev`;
  assert.equal(immutableOrigin(origin,deployment,id.site),origin);
  for(const u of [origin.replace('12345678-','mutable-'),origin+'/path',origin+'?secret=x',origin.replace('https:','http:'),origin.replace(id.site,id.mcp),'https://user:pass@'+new URL(origin).host])assert.throws(()=>immutableOrigin(u,deployment,id.site));
  const config='/owned/site.json',name='pr44-12345678-1',time=new Date().toISOString();
  const session={type:'wrangler-session',version:1,wrangler_version:'4.135.0',command_line_args:['preview','--config',config,'--worker-name',id.site,'--name',name,'--ignore-base-config','--json'],timestamp:time};
  const record={type:'preview',version:1,preview_name:name,worker_name:id.site,preview_id:'owned',deployment_id:deployment,deployment_urls:[origin],preview_urls:[],timestamp:time};
  const parse=r=>parsePreview(JSON.stringify(session)+'\n'+JSON.stringify(r),{worker:id.site,name,config,createdAt:Date.parse(time)});
  assert.equal(parse(record).origin,origin);assert.throws(()=>parse({...record,deployment_urls:[origin,origin]}));assert.throws(()=>parse({...record,preview_urls:[origin]}));assert.throws(()=>parse({...record,worker_name:id.mcp}));
});
