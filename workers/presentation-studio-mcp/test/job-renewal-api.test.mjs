// Owned offline controls: actual current33 API and SQLite; no provider/cloud/runtime dispatch.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../',import.meta.url));
const hooks=registerHooks({resolve(specifier,context,next){
  return next(specifier.startsWith('.')&&!path.extname(specifier)?specifier+'.ts':specifier,context);
}});
const {handleJobApi}=await import(pathToFileURL(path.join(source,'src/jobs.ts')).href);
const {recoverExpiredJobLeases}=await import(pathToFileURL(path.join(source,'src/job-lease.mjs')).href);
hooks.deregister();
const JOB='22222222-2222-2222-2222-222222222222',PROJECT='11111111-1111-1111-1111-111111111111',TOKEN='owned-minideck9-runner';

class D1 {
  constructor(sqlite){this.sqlite=sqlite;this.calls=0;}
  prepare(sql){this.calls++;const sqlite=this.sqlite;let args=[];return{
    bind(...values){args=values;return this;},
    async first(){return sqlite.prepare(sql).get(...args)??null;},
    async all(){return{results:sqlite.prepare(sql).all(...args)};},
    async run(){return{meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},
  };}
  async batch(statements){this.sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(await s.run());this.sqlite.exec('COMMIT');return results;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
function fixture({status='running',attempt=1,lease="datetime('now','+10 seconds')",started="datetime('now','-61 minutes')",type='render'}={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(path.join(source,'migrations/0001_init.sql'),'utf8'));
  sqlite.prepare("INSERT INTO presentation_projects(id,status) VALUES(?,'running')").run(PROJECT);
  sqlite.prepare('INSERT INTO presentation_project_runtime(project_id) VALUES(?)').run(PROJECT);
  sqlite.prepare(`INSERT INTO presentation_jobs(id,project_id,job_type,status,payload_json,attempt_count,max_attempts,leased_until,started_at) VALUES(?,?,?,?,'{}',?,3,${lease},${started})`).run(JOB,PROJECT,type,status,attempt);
  const db=new D1(sqlite);return{sqlite,db,env:{DB:db,PRESENTATION_RUNNER_TOKEN:TOKEN,BUCKET:{async head(){throw Error('No bucket/provider effect is permitted');},async put(){throw Error('No bucket/provider effect is permitted');}}}};
}
function state(f){const tables=['presentation_jobs','presentation_projects','presentation_project_runtime','presentation_versions','presentation_events'];return JSON.stringify(tables.map(t=>[t,f.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));}
async function renew(f,{body={jobId:JOB,attemptCount:1},token=TOKEN,method='POST'}={}){
  const response=await handleJobApi(new Request('https://owned.invalid/internal/jobs/renew',{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}),f.env);
  return{status:response.status,body:await response.json()};
}

test('actual API renews healthy same attempt after61minutes without claim/attempt/start/result mutations',async()=>{
  const f=fixture();try{
    const before={...f.sqlite.prepare('SELECT * FROM presentation_jobs').get()};
    const response=await renew(f);assert.equal(response.status,200);assert.equal(response.body.status,'renewed');
    const after={...f.sqlite.prepare('SELECT * FROM presentation_jobs').get()};assert.ok(after.leased_until>before.leased_until);
    assert.equal(f.sqlite.prepare("SELECT leased_until<=datetime('now','+60 minutes') AS bounded FROM presentation_jobs").get().bounded,1);
    for(const key of Object.keys(before).filter(k=>!['leased_until','updated_at'].includes(k)))assert.deepEqual(after[key],before[key],key);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM presentation_versions').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM presentation_events').get().n,0);
  }finally{f.sqlite.close();}
});

test('actual API missing or wrong runner authentication rejects before every DB operation',async()=>{
  for(const token of ['', 'other-owned-runner']){const f=fixture();try{const before=state(f),result=await renew(f,{token});assert.equal(result.status,401);assert.equal(f.db.calls,0);assert.equal(state(f),before);}finally{f.sqlite.close();}}
});

test('actual API malformed renewal request cannot touch SQLite',async()=>{
  for(const body of [null,[],{}, {jobId:'not-a-job',attemptCount:1},{jobId:JOB,attemptCount:0},{jobId:JOB,attemptCount:1.5},{jobId:JOB,attemptCount:'1'}]){
    const f=fixture();try{const before=state(f),result=await renew(f,{body});assert.equal(result.status,400);assert.equal(f.db.calls,0);assert.equal(state(f),before);}finally{f.sqlite.close();}
  }
});

test('actual API expired stale terminal and malformed leases never resurrect or mutate a job',async()=>{
  for(const options of [
    {lease:"datetime('now','-1 second')"},{lease:"datetime('now')"},{attempt:2},
    {status:'queued'},{status:'succeeded'},{status:'failed'},{status:'blocked'},
    {lease:'NULL'},{lease:"'unknown'"},{lease:"'2099-02-30 00:00:00'"},{lease:"'2099-13-01 00:00:00'"},{lease:"'2099-01-01T00:00:00Z'"},
    {started:'NULL'},{started:"'unknown'"},{started:"'2099-02-30 00:00:00'"},{started:"datetime('now','+1 minute')"},{started:"datetime('now','-6 hours')"},
  ]){const f=fixture(options);try{const before=state(f),result=await renew(f);assert.equal(result.status,409,JSON.stringify(options));assert.equal(state(f),before);}finally{f.sqlite.close();}}
});

test('actual API finite total horizon clamps extensions and refuses client-provided deadlines',async()=>{
  const f=fixture({type:'plan',started:"datetime('now','-13210 seconds')"});try{
    const before=state(f),bad=await renew(f,{body:{jobId:JOB,attemptCount:1,leasedUntil:'2099-01-01 00:00:00',leaseSeconds:99999999}});assert.equal(bad.status,400);assert.equal(state(f),before);
    const result=await renew(f);assert.equal(result.status,200);assert.equal(f.sqlite.prepare("SELECT leased_until=datetime(started_at,'+13310 seconds') AS at_horizon FROM presentation_jobs").get().at_horizon,1);
  }finally{f.sqlite.close();}
});

test('actual API renewed healthy attempt can still complete once after initial60minute age',async()=>{
  const f=fixture();try{
    assert.equal((await renew(f)).status,200);
    const response=await handleJobApi(new Request('https://owned.invalid/internal/jobs/complete',{method:'POST',headers:{authorization:'Bearer '+TOKEN},body:JSON.stringify({jobId:JOB,attemptCount:1,status:'failed',error:'Owned finite lifecycle completion'})}),f.env);
    assert.equal(response.status,200);assert.equal((await response.json()).status,'failed');
    const before=state(f);assert.equal((await renew(f)).status,409);assert.equal(state(f),before);
  }finally{f.sqlite.close();}
});

test('native renewal CAS cannot overwrite an owner or timestamp changed after the API read',async()=>{
  for(const mutation of [
    "UPDATE presentation_jobs SET attempt_count=2,leased_until=datetime('now','+30 minutes')",
    "UPDATE presentation_jobs SET leased_until='2099-02-30 00:00:00'",
    "UPDATE presentation_jobs SET started_at='2099-02-30 00:00:00'",
  ]){
    const f=fixture();try{
      const prepare=f.db.prepare.bind(f.db);let competitor;
      f.db.prepare=(sql)=>{if(sql.startsWith('UPDATE presentation_jobs SET ')&&sql.includes('RETURNING')){f.sqlite.exec(mutation);competitor=state(f);}return prepare(sql);};
      assert.equal((await renew(f)).status,409);assert.equal(state(f),competitor);
    }finally{f.sqlite.close();}
  }
});

test('native recovery leaves a renewed running attempt and its result tables untouched',async()=>{
  const f=fixture();try{
    assert.equal((await renew(f)).status,200);const before=state(f);
    assert.deepEqual(await recoverExpiredJobLeases(f.db,()=>{throw Error('No new event is permitted');}),{requeued:0,blocked:0});
    assert.equal(state(f),before);
  }finally{f.sqlite.close();}
});

test('all supported job types clamp at their finite source-derived horizon and reject elapsed horizons',async()=>{
  for(const [type,horizon] of Object.entries({plan:13310,render:20690,revision:22580,export:20690})){
    const f=fixture({type,started:`datetime('now','-${horizon-100} seconds')`});try{
      assert.equal((await renew(f)).status,200);
      assert.equal(f.sqlite.prepare(`SELECT leased_until=datetime(started_at,'+${horizon} seconds') AS bounded FROM presentation_jobs`).get().bounded,1);
    }finally{f.sqlite.close();}
    const expired=fixture({type,started:`datetime('now','-${horizon} seconds')`});try{
      const before=state(expired);assert.equal((await renew(expired)).status,409);assert.equal(state(expired),before);
    }finally{expired.sqlite.close();}
  }
});
