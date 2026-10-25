import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {admit} from './gate.mjs';
const raw='a'.repeat(64),hash=createHash('sha256').update(raw).digest('hex'),tree='4e7f083aa5208fb4d74b5c1091d290d0e5e507e3',sha='d'.repeat(40);
function fixture(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('migrations/0001_run_gate.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO minideck_qa_run VALUES(?,?,?,?,?,?,?,?)').run('123-1',hash,sha,tree,1000,11000,0,5);
  const DB = {
    prepare(sql) {
      const order=[];
      const normalized=sql.replace(/\?(\d+)/g,(_,n)=>{order.push(Number(n)-1);return '?';});
      return {
        bind(...args) {
          return { async first() { return db.prepare(normalized).get(...order.map(i=>args[i]))||null; } };
        },
      };
    },
  };
  const env={QA_SOURCE_SHA:sha,QA_PRODUCT_TREE:tree,QA_RUN:'123-1',DB};
  return{db,env,request:(key=raw)=>new Request('https://owned.invalid/',{headers:{'x-minideck-qa':key}})};}
test('inactive first deployment is deny-all, including valid credential',async()=>{const f=fixture();try{assert.equal((await admit(f.request(),f.env,2000)).status,401);}finally{f.db.close();}});
test('active gate admits exact source/run/hash and atomically bounds requests',async()=>{const f=fixture();try{f.db.exec('UPDATE minideck_qa_run SET active=1');for(let i=0;i<5;i++)assert.equal(await admit(f.request(),f.env,2000),null);assert.equal((await admit(f.request(),f.env,2000)).status,401);}finally{f.db.close();}});
test('row revocation denies both old and new immutable entry instances',async()=>{const f=fixture();try{f.db.exec('UPDATE minideck_qa_run SET active=1');assert.equal(await admit(f.request(),f.env,2000),null);const prior={...f.env};f.db.exec('UPDATE minideck_qa_run SET active=0');for(const env of [prior,f.env])assert.equal((await admit(f.request(),env,2000)).status,401);}finally{f.db.close();}});
test('expiry, missing row, source drift, malformed hash and database errors deny before product',async()=>{const f=fixture();try{f.db.exec('UPDATE minideck_qa_run SET active=1');assert.equal((await admit(f.request(),f.env,11000)).status,401);assert.equal((await admit(f.request('wrong'),f.env,2000)).status,401);assert.equal((await admit(f.request(),{...f.env,QA_SOURCE_SHA:'e'.repeat(40)},2000)).status,401);f.db.exec('DELETE FROM minideck_qa_run');assert.equal((await admit(f.request(),f.env,2000)).status,401);f.db.exec('DROP TABLE minideck_qa_run');assert.equal((await admit(f.request(),f.env,2000)).status,503);}finally{f.db.close();}});
test('corrupt text/fractional/oversized counters and timestamps fail closed in native SQL',async()=>{for(const patch of ["requests_left='oops'",'requests_left=1.5','requests_left=201',"created_at='oops'",'expires_at=11000.5','active=1.5']){const f=fixture();try{f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.exec('UPDATE minideck_qa_run SET active=1,'+patch);assert.equal((await admit(f.request(),f.env,2000))?.status,401,patch);}finally{f.db.close();}}});
