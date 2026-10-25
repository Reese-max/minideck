import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fixtureRequest} from './fixtures.mjs';
import {ownedStudioSeed} from '../scripts/isolated-preview.mjs';
const scope='minideck-qa-123456abcdef',run='12345678-1',project='11111111-1111-4111-8111-111111111111',hashes=['a'.repeat(64),'b'.repeat(64)];
const digest=text=>createHash('sha256').update(text).digest('hex');
function fixture(kind){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL(kind==='site'?'../schema.sql':'../workers/presentation-studio-mcp/migrations/0001_init.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){const order=[];const normalized=sql.replace(/\?(\d+)/g,(_,n)=>{order.push(Number(n)-1);return '?';});let args=[];
    const values=()=>order.length?order.map(i=>args[i]):args;return{bind(...v){args=v;return this;},async first(){return sqlite.prepare(normalized).get(...values())||null;},async all(){return{results:sqlite.prepare(normalized).all(...values())};},async run(){return{meta:{changes:Number(sqlite.prepare(normalized).run(...values()).changes)}};}};},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const stmt of statements)out.push(await stmt.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const objects=new Map([['unrelated/keep','untouched']]);let failSecondPut=false,puts=0;
  const BUCKET={async put(key,value){objects.set(key,String(value));if(failSecondPut&&++puts===2)throw new Error('Owned partial PUT fixture');},async get(key){const value=objects.get(key);return value===undefined?null:{size:Buffer.byteLength(value),async text(){return value;}};},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key);},async list({prefix='',limit=100}={}){const found=[...objects].filter(([key])=>key.startsWith(prefix));return{truncated:found.length>limit,objects:found.slice(0,limit).map(([key,value])=>({key,size:Buffer.byteLength(value)}))};}};
  const env={DB,BUCKET,QA_RUN:run,QA_SCOPE:scope,QA_CREATED_AT:String(Date.now())};
  if(kind==='mcp')sqlite.exec(ownedStudioSeed({scope,siteD1Id:'11111111-1111-4111-8111-111111111111',studioD1Id:'22222222-2222-4222-8222-222222222222',bucket:scope+'-assets'}));
  return{sqlite,env,objects,partialPut(){failSecondPut=true;}};
}
const request=(path,body)=>new Request('https://owned.invalid/__qa/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
test('lost MCP create response recovers only run-profile owners and removes exact idempotency keys',async()=>{const f=fixture('mcp');try{
  await fixtureRequest(request('seed',{tokenHashes:hashes}),f.env,'mcp');
  f.sqlite.prepare('INSERT INTO presentation_projects(id,profile_id) VALUES(?,?)').run(project,scope+'-profile');
  f.sqlite.prepare('INSERT INTO presentation_project_runtime(project_id,owner_id) VALUES(?,?)').run(project,'github:420000001');
  const key=digest(JSON.stringify(['presentation_idempotency:v1','github:420000001','qa-'+run]));f.sqlite.prepare("INSERT INTO presentation_idempotency(idempotency_key,tool_name,result_json) VALUES(?,'create_presentation','{}')").run(key);
  f.objects.set(`${scope}/projects/${project}/source-map.json`,JSON.stringify({projectId:project,sources:[],claims:[]}));
  const result=await(await fixtureRequest(request('cleanup',{projects:[],tokenHashes:hashes}),f.env,'mcp')).json();
  assert.equal(result.clean,true);assert.deepEqual(result.projects,[project]);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM presentation_idempotency').get().n,0);assert.equal(f.objects.get('unrelated/keep'),'untouched');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM presentation_projects').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM presentation_oauth_tokens').get().n,0);
}finally{f.sqlite.close();}});
test('pre-batch source-map orphan is recognized narrowly; unknown owned-prefix payload prevents clean claim',async()=>{for(const recognized of [true,false]){const f=fixture('mcp');try{
  const key=`${scope}/projects/${project}/`+(recognized?'source-map.json':'unknown.bin');f.objects.set(key,recognized?JSON.stringify({projectId:project,sources:[],claims:[]}):'unexpected');
  const result=await(await fixtureRequest(request('cleanup',{projects:[],tokenHashes:hashes}),f.env,'mcp')).json();
  assert.equal(result.clean,recognized);assert.equal(f.objects.has(key),!recognized);assert.equal(f.objects.get('unrelated/keep'),'untouched');
}finally{f.sqlite.close();}}});
test('partial stored legacy seed cleans orphan PUT and exact run rows without unrelated objects',async()=>{const f=fixture('site');try{
  f.partialPut();await assert.rejects(fixtureRequest(request('seed',{projectTokenHash:hashes[0]}),f.env,'site'),/partial PUT/);
  assert.ok([...f.objects.keys()].some(x=>x.startsWith('decks/qa-'+run+'/')));
  const result=await(await fixtureRequest(request('cleanup',{}),f.env,'site')).json();assert.equal(result.clean,true);assert.equal(f.objects.size,1);assert.equal(f.objects.get('unrelated/keep'),'untouched');
}finally{f.sqlite.close();}});
test('foreign profile ownership cannot be silently deleted as an owned partial create',async()=>{const f=fixture('mcp');try{
  f.sqlite.prepare("INSERT INTO presentation_projects(id,profile_id) VALUES(?,'different-profile')").run(project);f.sqlite.prepare("INSERT INTO presentation_project_runtime(project_id,owner_id) VALUES(?,'github:420000001')").run(project);
  await assert.rejects(fixtureRequest(request('cleanup',{projects:[project],tokenHashes:hashes}),f.env,'mcp'),/Foreign cleanup/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM presentation_projects').get().n,1);
}finally{f.sqlite.close();}});
