// Fixed owned synthetic data only. Every route is behind the live run gate.
import {deleteProjectData} from '../src/store.js';
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const json=(value,status=200)=>Response.json(value,{status});
const day=env=>new Date(Number(env.QA_CREATED_AT)).toISOString().slice(0,10).replaceAll('-','');
const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const fixtureDeck=label=>'<!doctype html><html><head><style>html,body{margin:0}.slide{width:1920px;height:1080px;padding:80px;box-sizing:border-box;font:36px Arial}h1{font-size:72px}</style></head><body>'+Array.from({length:40},(_,i)=>`<section class="slide"><h1>${label} ${i+1}</h1><p>11 22 33 44 55 66 77 88. Owned synthetic fixture. No external sources.</p></section>`).join('')+'<script>globalThis.qaDeckScriptRan=true</script></body></html>';
async function body(request) {
  if(!request.body)return {};
  const reader=request.body.getReader();let text='',bytes=0;const decoder=new TextDecoder();
  try{while(true){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;if(bytes>8192){void reader.cancel().catch(()=>{});throw new Error('Fixture body too large');}text+=decoder.decode(p.value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}
async function deleteObjects(bucket,prefix) {
  const objects=await bucket.list({prefix,limit:20});
  if(objects.truncated||objects.objects.some(x=>!x.key.startsWith(prefix))||objects.objects.length>10)throw new Error('Unexpected owned cleanup extent');
  if(objects.objects.length)await bucket.delete(objects.objects.map(x=>x.key));
  return objects.objects.map(x=>x.key);
}
export async function fixtureRequest(request,env,kind) {
  const url=new URL(request.url),projectId=`qa-${env.QA_RUN}`;
  if(url.pathname==='/__qa/status'&&request.method==='GET')return json({kind,run:env.QA_RUN,sourceSha:env.QA_SOURCE_SHA,productTree:env.QA_PRODUCT_TREE,version:env.CF_VERSION_METADATA?.id||'',providerConfigured:false,workflowConfigured:false});
  if(url.pathname==='/__qa/seed'&&request.method==='POST') {
    const input=await body(request);
    if(kind==='site') {
      if(!HEX.test(input.projectTokenHash||''))return json({error:'invalid_fixture_hash'},400);
      await env.DB.prepare("INSERT INTO projects(id,brief,access_token_hash,current_version,published_version,status) VALUES(?1,'Owned synthetic fixture',?2,2,1,'ready')").bind(projectId,input.projectTokenHash).run();
      const keys=[];
      for(const version of [1,2]){const key=`decks/${projectId}/${version}.html`;keys.push(key);await env.BUCKET.put(key,fixtureDeck(`FIXTURE_V${version}`));
        await env.DB.prepare("INSERT INTO versions(project_id,version,r2_key,origin,created_at) VALUES(?1,?2,?3,'qa-stored-fixture',?4)").bind(projectId,version,key,Date.now()).run();}
      await env.DB.prepare("INSERT INTO quotas(scope,day,count) VALUES('global:text',?1,7)").bind(day(env)).run();
      await env.DB.prepare("INSERT INTO quotas(scope,day,count) VALUES(?1,'all',2)").bind(`proj:${projectId}:revises`).run();
      return json({projectId,keys,bytes:2*new TextEncoder().encode(fixtureDeck('FIXTURE_V1')).byteLength});
    }
    if(!Array.isArray(input.tokenHashes)||input.tokenHashes.length!==2||!input.tokenHashes.every(x=>HEX.test(x)))return json({error:'invalid_fixture_hashes'},400);
    for(let i=0;i<2;i++)await env.DB.prepare('INSERT INTO presentation_oauth_tokens(access_token_hash,owner_login,scopes_json,access_expires_at,refresh_expires_at) VALUES(?1,?2,?3,?4,?4)')
      .bind(input.tokenHashes[i],`github:${420000001+i}`,'["presentation:read","presentation:write"]',new Date(Number(env.QA_CREATED_AT)+900000).toISOString()).run();
    return json({owners:['github:420000001','github:420000002'],tokenCount:2});
  }
  if(url.pathname==='/__qa/state'&&request.method==='GET'&&kind==='site') {
    return json({project:await env.DB.prepare('SELECT current_version,published_version,status FROM projects WHERE id=?1').bind(projectId).first(),
      quotas:(await env.DB.prepare("SELECT scope,day,count FROM quotas WHERE (scope='global:text' AND day=?1) OR scope LIKE ?2 ORDER BY scope,day").bind(day(env),`proj:${projectId}:%`).all()).results});
  }
  if(url.pathname==='/__qa/revoke-token'&&request.method==='POST'&&kind==='mcp') {
    const input=await body(request);
    if(!HEX.test(input.tokenHash||'')||![0,1].includes(input.owner))return json({error:'invalid_fixture_token'},400);
    await env.DB.prepare("UPDATE presentation_oauth_tokens SET revoked_at=datetime('now') WHERE access_token_hash=?1 AND owner_login=?2").bind(input.tokenHash,`github:${420000001+input.owner}`).run();
    return json({revoked:true,owner:input.owner});
  }
  if(url.pathname==='/__qa/cleanup'&&request.method==='POST') {
    const input=await body(request),deleted=[];
    if(kind==='site') {
      await deleteProjectData(env.DB,env.BUCKET,projectId);
      const orphaned=await deleteObjects(env.BUCKET,`decks/${projectId}/`);
      await env.DB.prepare("DELETE FROM quotas WHERE scope='global:text' AND day=?1").bind(day(env)).run();
      const remaining=(await env.BUCKET.list({prefix:`decks/${projectId}/`,limit:1})).objects.length;
      const project=await env.DB.prepare('SELECT id FROM projects WHERE id=?1').bind(projectId).first();
      const versions=await env.DB.prepare('SELECT count(*) AS n FROM versions WHERE project_id=?1').bind(projectId).first();
      const messages=await env.DB.prepare('SELECT count(*) AS n FROM messages WHERE project_id=?1').bind(projectId).first();
      const quota=await env.DB.prepare("SELECT count(*) AS n FROM quotas WHERE (scope='global:text' AND day=?1) OR scope LIKE ?2").bind(day(env),`proj:${projectId}:%`).first();
      return json({clean:!project&&versions.n===0&&messages.n===0&&quota.n===0&&remaining===0,projectId,remaining,orphanedKeys:orphaned});
    }
    if(!Array.isArray(input.projects)||input.projects.length>2||!input.projects.every(p=>UUID.test(p))||!Array.isArray(input.tokenHashes)||input.tokenHashes.length!==2||!input.tokenHashes.every(h=>HEX.test(h)))return json({error:'invalid_owned_receipt'},400);
    // Recover a create whose HTTP response was lost: only these two synthetic
    // owners AND this run's fresh profile can identify an owned partial result.
    const recovered=(await env.DB.prepare('SELECT p.id FROM presentation_projects p JOIN presentation_project_runtime r ON r.project_id=p.id WHERE p.profile_id=?1 AND r.owner_id IN(?2,?3) LIMIT 3')
      .bind(`${env.QA_SCOPE}-profile`,'github:420000001','github:420000002').all()).results.map(x=>x.id);
    const projects=[...new Set([...input.projects,...recovered])];if(projects.length>2||!projects.every(x=>UUID.test(x)))throw new Error('Unexpected owned partial-create extent');
    let remainingRows=0,remainingObjects=0;
    for(const id of projects) {
      const owner=await env.DB.prepare('SELECT r.owner_id,p.profile_id FROM presentation_project_runtime r JOIN presentation_projects p ON p.id=r.project_id WHERE p.id=?1').bind(id).first();
      if(!owner)continue;
      if(!['github:420000001','github:420000002'].includes(owner.owner_id)||owner.profile_id!==`${env.QA_SCOPE}-profile`)throw new Error('Foreign cleanup project');
      deleted.push(...await deleteObjects(env.BUCKET,`${env.QA_SCOPE}/projects/${id}/`));
      for(const table of ['presentation_profile_memory','presentation_approvals','presentation_artifacts','presentation_issues','presentation_jobs','presentation_events','presentation_claims','presentation_sources']){
        const column=table==='presentation_profile_memory'?'source_project_id':'project_id';
        await env.DB.prepare(`DELETE FROM ${table} WHERE ${column}=?1`).bind(id).run();}
      await env.DB.prepare('DELETE FROM presentation_version_runtime WHERE version_id IN (SELECT id FROM presentation_versions WHERE project_id=?1)').bind(id).run();
      for(const table of ['presentation_versions','presentation_project_runtime','presentation_pending_actions'])await env.DB.prepare(`DELETE FROM ${table} WHERE project_id=?1`).bind(id).run();
      await env.DB.prepare('DELETE FROM presentation_projects WHERE id=?1').bind(id).run();
      for(const table of ['presentation_projects','presentation_versions','presentation_project_runtime','presentation_pending_actions','presentation_jobs','presentation_events','presentation_claims','presentation_sources','presentation_artifacts','presentation_issues','presentation_approvals','presentation_profile_memory']){
        const column=table==='presentation_projects'?'id':table==='presentation_profile_memory'?'source_project_id':'project_id';
        remainingRows+=(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?1`).bind(id).first()).n;}
      remainingObjects+=(await env.BUCKET.list({prefix:`${env.QA_SCOPE}/projects/${id}/`,limit:1})).objects.length;
    }
    for(let i=0;i<2;i++)await env.DB.prepare('DELETE FROM presentation_oauth_tokens WHERE access_token_hash=?1 AND owner_login=?2').bind(input.tokenHashes[i],`github:${420000001+i}`).run();
    const idempotencyKeys=[];
    for(let i=0;i<2;i++){
      const key=await digest(JSON.stringify(['presentation_idempotency:v1',`github:${420000001+i}`,`qa-${env.QA_RUN}`]));idempotencyKeys.push(key);
      await env.DB.prepare("DELETE FROM presentation_idempotency WHERE idempotency_key=?1 AND tool_name='create_presentation'").bind(key).run();
      remainingRows+=(await env.DB.prepare('SELECT count(*) AS n FROM presentation_idempotency WHERE idempotency_key=?1').bind(key).first()).n;
      remainingRows+=(await env.DB.prepare('SELECT count(*) AS n FROM presentation_oauth_tokens WHERE access_token_hash=?1 AND owner_login=?2').bind(input.tokenHashes[i],`github:${420000001+i}`).first()).n;
    }
    await env.DB.prepare("DELETE FROM presentation_profiles WHERE id=?1 AND name='Owned isolated fixture'").bind(`${env.QA_SCOPE}-profile`).run();
    await env.DB.prepare('DELETE FROM presentation_system_config WHERE config_key=?1 AND value_json=?2').bind('architecture',JSON.stringify({version:'2.0.0',openDesignEnabled:false,renderer:'dashi',orchestrator:'cloudflare-workflow'})).run();
    remainingRows+=(await env.DB.prepare('SELECT count(*) AS n FROM presentation_profiles WHERE id=?1').bind(`${env.QA_SCOPE}-profile`).first()).n;
    remainingRows+=(await env.DB.prepare("SELECT count(*) AS n FROM presentation_system_config WHERE config_key='architecture'").first()).n;
    // A process may die after source-map PUT but before the atomic DB batch.
    // Recover only the two recognizable empty-input source maps from this
    // proven fresh run scope; unknown payloads/paths remain an explicit failure.
    const prefix=`${env.QA_SCOPE}/projects/`,orphans=await env.BUCKET.list({prefix,limit:3});
    if(orphans.truncated||orphans.objects.length>2)remainingObjects+=orphans.objects.length||1;
    else for(const object of orphans.objects){
      const suffix=object.key.slice(prefix.length),parts=suffix.split('/');
      if(!object.key.startsWith(prefix)||parts.length!==2||!UUID.test(parts[0])||parts[1]!=='source-map.json'||object.size>4096){remainingObjects++;continue;}
      const stored=await env.BUCKET.get(object.key);let map;
      try{map=JSON.parse(await stored.text());}catch{remainingObjects++;continue;}
      if(map.projectId!==parts[0]||!Array.isArray(map.sources)||map.sources.length||!Array.isArray(map.claims)||map.claims.length){remainingObjects++;continue;}
      await env.BUCKET.delete(object.key);deleted.push(object.key);
    }
    remainingObjects+=(await env.BUCKET.list({prefix,limit:1})).objects.length;
    return json({clean:remainingRows===0&&remainingObjects===0,projects,deletedKeys:deleted,idempotencyKeys,remainingRows,remainingObjects,retained:['QA admission audit row; controller revokes separately','schemas and cloud resources; unrelated data is preserved']});
  }
  return json({error:'unknown_fixed_fixture_route'},404);
}
