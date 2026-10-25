// Remote methods are invoked only by the explicitly admitted CI controller.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {root,parsePreview,runIdentity} from './contract.mjs';
import {productionInventory} from '../scripts/isolated-preview.mjs';
export function cloudClient(env,fetchImpl=fetch,{used=0,record=()=>{}}={}) {
  assert.match(env.CLOUDFLARE_ACCOUNT_ID||'',/^[a-f0-9]{32}$/);
  assert.ok(env.CLOUDFLARE_API_TOKEN,'Missing existing infrastructure API token');
  assert.ok(!env.WRANGLER_API_TOKEN&&!env.CLOUDFLARE_API_KEY&&!env.CLOUDFLARE_API_BASE_URL&&!env.CF_API_BASE_URL,'Alternate infrastructure credentials/endpoints refused');
  const prefix=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  assert.ok(Number.isInteger(used)&&used>=0&&used<=100);let requests=used;
  return {get requests(){return requests;},async request(path,{method='GET',body,cleanup=false}={}) {
    assert.ok(path.startsWith('/')&&!path.includes('..')&&!path.includes('#'));
    const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',name='minideck-qa-[a-f0-9]{12}-(?:site-db|studio-db|assets)';
    const allowed=method==='GET'?new RegExp(`^/(?:workers/(?:scripts|workers)|d1/database(?:/${uuid})?|r2/buckets(?:/${name})?)(?:\\?per_page=100)?$`)
      :method==='POST'?new RegExp(`^/(?:d1/database(?:/${uuid}/query)?|r2/buckets)$`):null;
    assert.ok(allowed?.test(path),'Unreviewed management endpoint refused');
    assert.ok(requests+1<=(cleanup?100:70),'Account API budget exhausted; cleanup reserve retained');record(++requests);
    const response=await fetchImpl(prefix+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){const error=new Error('Cloudflare account request refused');error.status=response.status;throw error;}
    const data=await response.json();assert.equal(data.success,true,'Cloudflare operation failed');
    return data;
  }};
}
export function readNames(data,kind) {
  const list=kind==='r2'?data.result?.buckets:kind==='native'?(data.result?.workers??data.result):data.result;
  assert.ok(Array.isArray(list),'Unrecognized account inventory');
  const info=data.result_info||{};
  assert.ok(!info.cursor&&!data.result?.cursor&&(info.total_pages??1)===1&&!info.truncated&&!info.is_truncated&&!info.has_more&&!data.result?.truncated&&!data.result?.is_truncated&&!data.result?.has_more,'Incomplete inventory refused');
  assert.ok(list.length<100||info.total_count===list.length,'Inventory completeness not proven');
  for(const field of ['count','total_count'])if(info[field]!==undefined)assert.ok(Number.isInteger(info[field])&&info[field]===list.length,'Incomplete inventory refused');
  if(info.page!==undefined)assert.equal(info.page,1,'Incomplete inventory refused');
  if(info.per_page!==undefined)assert.ok(Number.isInteger(info.per_page)&&info.per_page>=list.length&&info.per_page<=100,'Incomplete inventory refused');
  return list.map(row=>{const name=row.name??(kind==='site'?row.id:undefined);assert.equal(typeof name,'string');return name;});
}
export async function freshInventory(client,identity) {
  const found={};
  for(const[kind,path]of Object.entries({site:'/workers/scripts?per_page=100',native:'/workers/workers?per_page=100',d1:'/d1/database?per_page=100',r2:'/r2/buckets?per_page=100'}))found[kind]=readNames(await client.request(path),kind);
  for(const name of [identity.site,identity.mcp])assert.ok(!found.site.includes(name)&&!found.native.includes(name),'Preexisting Worker name refused');
  for(const name of [identity.siteDb,identity.studioDb])assert.ok(!found.d1.includes(name),'Preexisting D1 name refused');
  assert.ok(!found.r2.includes(identity.bucket),'Preexisting R2 bucket refused');
  return {checkedAt:Date.now(),counts:Object.fromEntries(Object.entries(found).map(([k,v])=>[k,v.length]))};
}
export async function query(client,id,sql,params=[],cleanup=false) {
  assert.match(id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const data=await client.request(`/d1/database/${id}/query`,{method:'POST',body:{sql,params},cleanup});
  assert.ok(Array.isArray(data.result)&&data.result.every(x=>x.success!==false),'D1 execution refused');
  return data.result;
}
export function nativeConfig(kind,state) {
  assert.ok(['site','mcp'].includes(kind));
  const worker=state.identity[kind],database=state.databases[kind];
  const [runId,attempt]=state.identity.run.split('-');const expectedScope=runIdentity(runId,attempt).scope;
  assert.equal(state.identity.scope,expectedScope);
  assert.equal(worker,`${expectedScope}-${kind}`);assert.equal(state.identity.bucket,`${expectedScope}-assets`);
  assert.equal(database.createdByRun,true);assert.equal(state.bucketCreated,true);
  assert.match(database.uuid,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert.notEqual(database.uuid,'00000000-0000-0000-0000-000000000000');
  assert.notEqual(state.databases.site.uuid,state.databases.mcp.uuid);assert.ok(!productionInventory().get('database-id').has(database.uuid),'Configured production UUID refused');
  assert.equal(database.name,kind==='site'?state.identity.siteDb:state.identity.studioDb);
  const config={name:worker,main:resolve(root,`qa/${kind}-entry.mjs`),compatibility_date:kind==='site'?'2026-07-29':'2026-08-28',compatibility_flags:['nodejs_compat'],
    workers_dev:false,preview_urls:true,routes:[],observability:{enabled:false},previews:{
      vars:{QA_SCOPE:state.identity.scope,QA_RUN:state.identity.run,QA_SOURCE_SHA:state.identity.sourceSha,QA_PRODUCT_TREE:'4e7f083aa5208fb4d74b5c1091d290d0e5e507e3',QA_CREATED_AT:String(state.createdAt)},
      d1_databases:[{binding:'DB',database_name:database.name,database_id:database.uuid}],
      r2_buckets:[{binding:'BUCKET',bucket_name:state.identity.bucket}],version_metadata:{binding:'CF_VERSION_METADATA'},observability:{enabled:false}}};
  if(kind==='site'){
    config.assets={directory:resolve(root,'public'),binding:'ASSETS',html_handling:'none',not_found_handling:'single-page-application',run_worker_first:true};
    config.rules=[{type:'Text',globs:['**/*.md'],fallthrough:true}];
  }
  return config;
}
export function uploadPreview(kind,state,directory) {
  assert.ok(state.cliCalls<4,'Fixed upload command budget exhausted');state.cliCalls++;
  const config=resolve(directory,`${kind}.json`),record=resolve(directory,`${kind}-preview.jsonl`),name=`pr44-${state.identity.run}`;
  writeFileSync(config,JSON.stringify(nativeConfig(kind,state)),{mode:0o600});writeFileSync(record,'',{mode:0o600,flag:'wx'});
  const args=['preview','--config',config,'--worker-name',state.identity[kind],'--name',name,'--ignore-base-config','--json'];
  const result=spawnSync(process.execPath,[resolve(root,'qa/node_modules/wrangler/bin/wrangler.js'),...args],{cwd:root,
    env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_OUTPUT_FILE_PATH:record,WRANGLER_OUTPUT_FILE_DIRECTORY:'',NO_COLOR:'1'},
    encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
  if(result.status!==0){const error=new Error('Native Preview upload failed');error.codes=[...String(result.stdout+result.stderr).matchAll(/\[code:\s*(\d{3,8})\]/g)].map(x=>Number(x[1])).slice(0,4);throw error;}
  const stat=statSync(record);assert.ok(stat.isFile()&&(stat.mode&0o077)===0&&stat.size<=16384);
  return parsePreview(readFileSync(record,'utf8'),{worker:state.identity[kind],name,config,createdAt:state.createdAt});
}
