// Fixed PR44 two-Worker/two-D1/one-R2 QA. No remote work on import.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,PRODUCT_SHA,PRODUCT_TREE,REPO,digest,validateSource,validateAdmission,sourceProvenance,ensureCleanupWindow} from './contract.mjs';
import {cloudClient,freshInventory,query,uploadPreview} from './cloud.mjs';
import {ownedStudioSeed} from '../scripts/isolated-preview.mjs';
const event=()=>JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
function paths(){assert.ok(process.env.RUNNER_TEMP?.startsWith('/'));const directory=resolve(process.env.RUNNER_TEMP,'minideck-pr44-stored-qa');mkdirSync(directory,{recursive:true,mode:0o700});return{directory,state:resolve(directory,'private-state.json')};}
function save(state){const p=paths(),next=p.state+'.next';writeFileSync(next,JSON.stringify(state),{mode:0o600});renameSync(next,p.state);}
function state(){return JSON.parse(readFileSync(paths().state,'utf8'));}
function report(value){const directory=resolve(root,'qa/output');mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'receipt.json'),JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value));}
export async function admitted(){validateSource();ensureCleanupWindow(process.env);const checkout=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.ok(process.env.GH_TOKEN,'Missing read-only workflow token');const response=await fetch(`https://api.github.com/repos/${REPO}/pulls/44`,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${process.env.GH_TOKEN}`,accept:'application/vnd.github+json'}});
  assert.equal(response.status,200,'Fresh PR head lease unavailable');return validateAdmission(process.env,event(),await response.json(),checkout);}
async function proofFetch(state,kind,path,init={}) {
  assert.ok(['site','mcp'].includes(kind));assert.ok(path.startsWith('/')&&!path.startsWith('//'));
  state.probeCalls=(state.probeCalls||0)+1;assert.ok(state.probeCalls<=180,'HTTP probe budget exhausted');
  return fetch(state.previews[kind].origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
}
export async function prepare(){const identity=await admitted(),p=paths();assert.ok(!existsSync(p.state),'Do not reuse a QA run');
  const s={identity,createdAt:Date.now(),expiresAt:Date.now()+900000,jobStartedAt:Number(process.env.MINIDECK_QA_JOB_STARTED_AT),gate:randomBytes(32).toString('hex'),projectToken:randomBytes(32).toString('hex'),mcpTokens:[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],databases:{},previews:{},cliCalls:0,phase:'preflight',probeCalls:0,accountRequests:0,provenance:sourceProvenance()};
  const client=cloudClient(process.env,fetch,{record:used=>{s.accountRequests=used;save(s);}});
  for(const key of [s.gate,s.projectToken,...s.mcpTokens])console.log('::add-mask::'+key);save(s);
  try {
    s.stage='fresh-inventory';s.inventory=await freshInventory(client,identity);save(s);
    for(const kind of ['site','mcp']){await admitted();const name=kind==='site'?identity.siteDb:identity.studioDb;
      s.stage='create-'+kind+'-database';save(s);const data=await client.request('/d1/database',{method:'POST',body:{name}});assert.equal(data.result.name,name);assert.match(data.result.uuid,/^[a-f0-9-]{36}$/);
      s.databases[kind]={name,uuid:data.result.uuid,createdByRun:true};save(s);
      const read=await client.request(`/d1/database/${data.result.uuid}`);assert.equal(read.result.uuid,data.result.uuid);assert.equal(read.result.name,name);
    }
    assert.notEqual(s.databases.site.uuid,s.databases.mcp.uuid);await admitted();
    s.stage='create-owned-bucket';save(s);const created=await client.request('/r2/buckets',{method:'POST',body:{name:identity.bucket}});assert.equal(created.result.name,identity.bucket);s.bucketCreated=true;save(s);
    const bucket=await client.request(`/r2/buckets/${identity.bucket}`);assert.equal(bucket.result.name,identity.bucket);
    for(const kind of ['site','mcp']){await admitted();s.stage='initialize-'+kind;save(s);
      const schema=readFileSync(resolve(root,kind==='site'?'schema.sql':'workers/presentation-studio-mcp/migrations/0001_init.sql'),'utf8');
      await query(client,s.databases[kind].uuid,schema);await query(client,s.databases[kind].uuid,readFileSync(resolve(root,'qa/migrations/0001_run_gate.sql'),'utf8'));
      if(kind==='mcp')await query(client,s.databases[kind].uuid,ownedStudioSeed({scope:identity.scope,siteD1Id:s.databases.site.uuid,studioD1Id:s.databases.mcp.uuid,bucket:identity.bucket}));
      await query(client,s.databases[kind].uuid,'INSERT INTO minideck_qa_run VALUES(?,?,?,?,?,?,0,?)',[identity.run,digest(s.gate),identity.sourceSha,PRODUCT_TREE,s.createdAt,s.expiresAt,kind==='site'?140:60]);
      await admitted();s.stage='upload-inactive-'+kind;save(s);s.previews[kind]=uploadPreview(kind,s,p.directory);s.previews[kind].configSha256=digest(readFileSync(resolve(p.directory,kind+'.json')));save(s);
      for(const path of ['/','/app.js','/owned-spa-path','/oauth/register'])for(const header of [{},{'x-minideck-qa':s.gate}]){
        const denied=await proofFetch(s,kind,path,{...(path==='/oauth/register'?{method:'POST',body:'{}'}:{}),headers:header});assert.equal(denied.status,401,'First immutable deployment must be deny-all');await denied.arrayBuffer();}
    }
    for(const kind of ['site','mcp']){await admitted();const activated=await query(client,s.databases[kind].uuid,'UPDATE minideck_qa_run SET active=1 WHERE run_id=? AND source_sha=?',[identity.run,identity.sourceSha]);assert.equal(activated[0]?.meta?.changes,1,'Exact inactive gate activation required');}
    s.phase='ready';s.accountRequests=client.requests;save(s);report({status:'READY_FOR_STORED_FIXTURE_QA',identity,provenance:s.provenance,productSha:PRODUCT_SHA,productTree:PRODUCT_TREE,previews:s.previews,resources:{databases:s.databases,bucket:identity.bucket},noProviderKeys:true,noRunnerWorkflowContainer:true,expiresAt:s.expiresAt,accountRequests:client.requests});
  }catch(error){s.phase='failed-prepare';s.failure={stage:s.stage,kind:error.constructor.name,status:error.status??null,codes:error.codes??[]};s.accountRequests=client.requests;save(s);report({status:'FAILED_CLOSED',identity,phase:s.phase,failure:s.failure,resources:{databases:s.databases,bucket:s.bucketCreated?identity.bucket:null},previews:s.previews});throw new Error('QA preparation stopped; inspect sanitized receipt');}
}
export async function verify(){await admitted();const s=state();assert.equal(s.phase,'ready');const {runBrowser}=await import('./run-browser.mjs');
  try{s.browser=await runBrowser(s);s.phase='verified';}catch(error){s.phase='failed-verify';s.failure={kind:error.constructor.name};throw error;}finally{save(s);report({status:s.phase,identity:s.identity,productSha:PRODUCT_SHA,productTree:PRODUCT_TREE,previews:s.previews,browser:s.browser??null,failure:s.failure??null});}}
export async function cleanup(){const p=paths();if(!existsSync(p.state)){report({status:'NO_PRIVATE_STATE_NO_RESOURCES_CREATED'});return;}
  const s=state();assert.deepEqual(s.identity,validateAdmission(process.env,event(),event().pull_request,s.identity.sourceSha));
  const client=cloudClient(process.env,fetch,{used:s.accountRequests||0,record:used=>{s.accountRequests=used;save(s);}}),result={ownedData:{},revoked:{},denied:{},errors:[]};
  // Exact owned cleanup first, then unconditional run-row revoke. Browser has
  // already closed; no provider/Workflow can be pending. SIGKILL is not caught:
  // hard expiry and an incomplete receipt remain the honest recovery boundary.
  try{for(const kind of ['site','mcp'])if(s.previews[kind])try{
    const response=await proofFetch(s,kind,'/__qa/cleanup',{method:'POST',headers:{'content-type':'application/json','x-minideck-qa':s.gate},body:JSON.stringify({projects:s.projects||[],tokenHashes:s.mcpTokens.map(digest)})});
    result.ownedData[kind]=response.status===200?await response.json():{clean:false,status:response.status};
  }catch{result.errors.push(kind+'-owned-data-cleanup');}}
  finally{for(const kind of ['site','mcp'])if(s.databases[kind])try{const revoked=await query(client,s.databases[kind].uuid,'UPDATE minideck_qa_run SET active=0 WHERE run_id=? AND source_sha=?',[s.identity.run,s.identity.sourceSha],true);assert.equal(revoked[0]?.meta?.changes,1);result.revoked[kind]=true;}catch{result.revoked[kind]=false;result.errors.push(kind+'-gate-revoke');}}
  for(const kind of ['site','mcp'])if(s.previews[kind])try{result.denied[kind]=true;
    for(const path of ['/','/app.js','/owned-spa-path','/oauth/register']){
      const r=await proofFetch(s,kind,path,{...(path==='/oauth/register'?{method:'POST',body:'{}'}:{}),headers:{'x-minideck-qa':s.gate}});
      result.denied[kind]&&=r.status===401;await r.arrayBuffer();}
  }catch{result.denied[kind]=false;}
  s.cleanup=result;save(s);
  const complete=s.phase==='verified'&&Object.keys(s.previews).length===2&&Object.values(result.ownedData).every(x=>x.clean===true)&&['site','mcp'].every(k=>result.revoked[k]&&result.denied[k])&&result.errors.length===0;
  report({status:complete?'PASS_STORED_FIXTURE_PREVIEW_RETIRED':'INCOMPLETE_OR_FAILED_QA',identity:s.identity,phase:s.phase,failure:s.failure??null,provenance:s.provenance,productSha:PRODUCT_SHA,productTree:PRODUCT_TREE,previews:s.previews,resources:{databases:s.databases,bucket:s.bucketCreated?s.identity.bucket:null},browser:s.browser??null,cleanup:result,expiryFallback:s.expiresAt,accountRequests:s.accountRequests,cliCalls:s.cliCalls,requestAccounting:'site140+MCP60 gate slots; account API100total separately persisted; nativeCLI internal upload requests not instrumented or included',cloudResourcesDeleted:0,applicationProviderSecretsUsed:0});
  if(!complete)throw new Error('QA remains incomplete; inspect sanitized retirement receipt');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const command=process.argv[2];if(command==='validate'){console.log(JSON.stringify(validateSource()));if(process.env.GITHUB_ACTIONS==='true')ensureCleanupWindow(process.env);}else if(command==='prepare')await prepare();else if(command==='verify')await verify();else if(command==='cleanup')await cleanup();else throw new Error('Unknown fixed QA command');}catch{console.error('Fixed PR44 QA stopped; see sanitized receipt.');process.exitCode=1;}}
