import assert from 'node:assert/strict';
import test from 'node:test';
import {cloudClient,freshInventory,nativeConfig,readNames} from './cloud.mjs';
import {runIdentity} from './contract.mjs';
const identity={...runIdentity('12345678','1'),sourceSha:'a'.repeat(40)};
test('account preflight is read-only and refuses incomplete or colliding names before creation',async()=>{
  const paths=[];const client={async request(path){paths.push(path);return{success:true,result:path.startsWith('/r2')?{buckets:[]}:[]};}};
  await freshInventory(client,identity);assert.equal(paths.length,4);assert.ok(paths.every(x=>!x.includes('/query')));
  for(const name of [identity.site,identity.mcp,identity.siteDb,identity.studioDb,identity.bucket]){
    const bad={async request(path){return{success:true,result:path.startsWith('/r2')?{buckets:[{name}]}:[{name}]};}};
    await assert.rejects(freshInventory(bad,identity),/Preexisting/);
  }
  await assert.rejects(freshInventory({async request(){return{result:[],result_info:{total_pages:2}};}},identity),/Incomplete/);
  for(const info of [{page:1,per_page:100,count:1,total_count:101},{count:2},{page:2},{cursor:'next'},{has_more:true}])assert.throws(()=>readNames({result:[{name:'unrelated'}],result_info:info},'native'),/Incomplete/);
});
test('management transport rejects redirects, unknown endpoints, deletion and credential fallbacks',async()=>{
  let calls=0;const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'owned-fixture-only'};
  const client=cloudClient(env,async(url,init)=>{calls++;assert.equal(init.redirect,'error');assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));return Response.json({success:true,result:[]});});
  await client.request('/workers/scripts');assert.equal(calls,1);
  for(const path of ['/billing','/workers/scripts/production','/../other'])await assert.rejects(client.request(path));
  await assert.rejects(client.request('/r2/buckets',{method:'DELETE'}));assert.equal(calls,1);
  assert.throws(()=>cloudClient({...env,CF_API_BASE_URL:'https://other.invalid'}));assert.throws(()=>cloudClient({...env,CLOUDFLARE_API_KEY:'fallback'}));
});
test('persisted management count reserves cleanup across controller processes',async()=>{
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'owned-fixture-only'};let used=70,calls=0;
  const fetcher=async()=>{calls++;return Response.json({success:true,result:[]});};
  const next=cloudClient(env,fetcher,{used,record:value=>used=value});
  await assert.rejects(next.request('/workers/scripts'),/budget/);assert.equal(calls,0);assert.equal(used,70);
  await next.request('/workers/scripts',{cleanup:true});assert.equal(used,71);assert.equal(calls,1);
  const exhausted=cloudClient(env,fetcher,{used:100});await assert.rejects(exhausted.request('/workers/scripts',{cleanup:true}),/budget/);assert.equal(calls,1);
});
test('fresh native configs cannot expose site assets before gate or add paid/shared bindings',()=>{
  const state={identity,createdAt:Date.now(),bucketCreated:true,databases:{site:{name:identity.siteDb,uuid:'11111111-1111-4111-8111-111111111111',createdByRun:true},mcp:{name:identity.studioDb,uuid:'22222222-2222-4222-8222-222222222222',createdByRun:true}}};
  const site=nativeConfig('site',state),mcp=nativeConfig('mcp',state);
  assert.equal(site.assets.run_worker_first,true);assert.equal(site.workers_dev,false);assert.equal(mcp.assets,undefined);
  assert.equal(site.assets.html_handling,'none');assert.equal(site.assets.not_found_handling,'single-page-application');
  for(const cfg of [site,mcp]){assert.deepEqual(cfg.routes,[]);assert.equal(cfg.previews.r2_buckets[0].bucket_name,identity.bucket);for(const key of ['services','workflows','containers','durable_objects','migrations','triggers'])assert.equal(cfg[key],undefined);assert.ok(Object.keys(cfg.previews.vars).every(x=>!/(TOKEN|SECRET|KEY|GITHUB)/.test(x)));}
  assert.notEqual(site.previews.d1_databases[0].database_id,mcp.previews.d1_databases[0].database_id);
});
