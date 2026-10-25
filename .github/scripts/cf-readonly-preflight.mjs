// PR44 credential readiness only: GET metadata, never deploy/create/refresh.
// PASS proves bounded complete inventory reads, not write rights, plans or billing.
import {execFileSync} from 'node:child_process';
import {readFileSync,appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const PRODUCT_TREE='4e7f083aa5208fb4d74b5c1091d290d0e5e507e3';
export const PRODUCT_HEAD='d082a767f47af50dc3a50ba2ea54f21deaae90f2';
const REPO='Reese-max/minideck', OWNER='Reese-max', BRANCH='feature/fix-new-issues-38-41';
const LIMIT=20, DEADLINE_MS=10000, MAX_BYTES=1024*1024;
const FAMILIES={workers_scripts:'/workers/scripts',workers_native:'/workers/workers',d1:'/d1/database',r2:'/r2/buckets'};
const own=(o,k)=>Object.hasOwn(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export class Refusal extends Error {
  constructor(stage,status,cf_code=null){super('Read-only preflight refused');Object.assign(this,{stage,status,cf_code});}
}
function refuse(stage,status,code=null){throw new Refusal(stage,status,code);}
export function receipt(stage,status,count=null,cf_code=null){return {schema:'minideck.cf-readonly-preflight/v1',stage,status,cf_code,count};}
const cfCode=data=>{const n=data?.errors?.[0]?.code;return integer(n)&&n<=1000000000?n:null;};

export function scope(env,event){
  const pr=event?.pull_request;
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REPOSITORY_OWNER!==OWNER||env.GITHUB_EVENT_NAME!=='pull_request'||
    env.GITHUB_ACTOR!==OWNER||env.GITHUB_TRIGGERING_ACTOR!==OWNER||!['opened','synchronize','reopened'].includes(event?.action)||
    event.number!==44||pr?.number!==44||pr.state!=='open'||pr.draft!==true||pr.user?.login!==OWNER||
    pr.head?.repo?.full_name!==REPO||pr.head?.repo?.owner?.login!==OWNER||pr.head.ref!==BRANCH||
    pr.base?.repo?.full_name!==REPO||pr.base.ref!=='main'||!/^\b[a-f0-9]{40}\b$/.test(pr.head.sha??''))refuse('scope','FAIL_SCOPE');
  return pr.head.sha;
}
function git(args){return execFileSync('git',args,{encoding:'utf8',timeout:1000,maxBuffer:2*MAX_BYTES,stdio:['ignore','pipe','ignore']});}
function entries(text){return new Map(text.split('\0').filter(Boolean).map(row=>{const i=row.indexOf('\t');if(i<0)refuse('source','FAIL_SOURCE');return [row.slice(i+1),row.slice(0,i)];}));}
export function verifyProduct(head,runGit=git){
  try {
    if(runGit(['rev-parse','HEAD']).trim()!==head)refuse('source','FAIL_SOURCE');
    const base=entries(runGit(['ls-tree','-r','-z','--full-tree',PRODUCT_TREE]));
    const current=entries(runGit(['ls-tree','-r','-z','--full-tree','HEAD']));
    if(!current.has('.github/scripts/cf-readonly-preflight.mjs')||!current.has('.github/workflows/cf-readonly-preflight.yml'))refuse('source','FAIL_SOURCE');
    if(base.size===0||[...base].some(([p,v])=>current.get(p)!==v))refuse('source','FAIL_SOURCE');
    for(const [p,v] of current)if(!base.has(p)&&(!/^100644 blob [a-f0-9]{40}$/.test(v)||
      !(['.github/scripts/cf-readonly-preflight.mjs','.github/workflows/cf-readonly-preflight.yml','.github/workflows/stored-preview-qa.yml'].includes(p)||/^qa\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+$/.test(p))))refuse('source','FAIL_SOURCE');
    if(runGit(['diff','--name-only','HEAD','--']).trim())refuse('source','FAIL_SOURCE');
    return base.size;
  }catch{refuse('source','FAIL_SOURCE');}
}

// One GitHub lease GET is reserved; at most19 CF GETs remain across all pages.
export function client({fetchImpl=fetch,now=Date.now,started,used=0}){
  if(!integer(started)||started>now()||now()-started>=DEADLINE_MS||!integer(used)||used>LIMIT)refuse('budget','FAIL_DEADLINE');
  let requests=used;
  return {get used(){return requests;},async get(url,token,stage){
    let target;try{target=new URL(url);}catch{refuse(stage,'FAIL_INPUT');}
    const keys=[...target.searchParams.keys()];
    const github=target.href==='https://api.github.com/repos/Reese-max/minideck/pulls/44';
    const cloud=target.origin==='https://api.cloudflare.com'&&!target.username&&!target.password&&!target.hash&&
      /^\/client\/v4\/accounts\/[a-f0-9]{32}\/(?:workers\/(?:scripts|workers)|d1\/database|r2\/buckets)$/.test(target.pathname)&&
      target.searchParams.get('per_page')==='100'&&new Set(keys).size===keys.length&&keys.length<=2&&
      keys.every(k=>['per_page','page','cursor'].includes(k))&&
      (!target.searchParams.has('page')||/^(?:[1-9]|1[0-9]|20)$/.test(target.searchParams.get('page')))&&
      (!target.searchParams.has('cursor')||(target.searchParams.get('cursor').length>0&&target.searchParams.get('cursor').length<=1024));
    if(!github&&!cloud)refuse(stage,'FAIL_INPUT');
    if(++requests>LIMIT)refuse(stage,'FAIL_LIMIT');
    const remaining=started+DEADLINE_MS-now();if(remaining<=0)refuse(stage,'FAIL_DEADLINE');
    const controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Refusal(stage,'FAIL_DEADLINE'));},remaining);});
    try{return await Promise.race([(async()=>{
      const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
      const reader=response.body?.getReader();if(!reader)refuse(stage,'FAIL_JSON');
      const chunks=[];let length=0;
      try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>MAX_BYTES)refuse(stage,'FAIL_LIMIT');chunks.push(next.value);}}
      finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{if(response.ok)refuse(stage,'FAIL_JSON');}
      if(!response.ok)refuse(stage,`FAIL_HTTP_${response.status}`,cfCode(data));
      if(!object(data))refuse(stage,'FAIL_JSON');return data;
    })(),timeout]);}
    catch(error){if(error instanceof Refusal)throw error;refuse(stage,'FAIL_NETWORK');}
    finally{clearTimeout(timer);controller.abort();}
  }};
}

export async function guard({env,event,fetchImpl=fetch,now=Date.now,runGit=git,emit=()=>{}}){
  const started=now(),head=scope(env,event);emit(receipt('source','PASS',verifyProduct(head,runGit)));
  if(typeof env.GH_TOKEN!=='string'||!env.GH_TOKEN.trim()||/[\r\n]/.test(env.GH_TOKEN))refuse('lease','FAIL_MISSING');
  const api=client({fetchImpl,now,started});
  const pr=await api.get('https://api.github.com/repos/Reese-max/minideck/pulls/44',env.GH_TOKEN,'lease');
  if(pr.number!==44||pr.state!=='open'||pr.draft!==true||pr.user?.login!==OWNER||pr.head?.sha!==head||
    pr.head?.repo?.full_name!==REPO||pr.head?.repo?.owner?.login!==OWNER||pr.head?.ref!==BRANCH||pr.base?.repo?.full_name!==REPO||pr.base.ref!=='main')refuse('lease','FAIL_LEASE');
  emit(receipt('lease','PASS',api.used));return {started,head,used:api.used};
}

export async function inventory(api,prefix,token,kind){
  if(!own(FAMILIES,kind))refuse('inventory','FAIL_INPUT');
  let page=1,cursor=null,total=null,pages=null,count=0;
  const ids=new Set(),cursors=new Set();
  for(;;){
    const url=new URL(prefix+FAMILIES[kind]);url.searchParams.set('per_page','100');
    if(cursor!==null)url.searchParams.set('cursor',cursor);else if(page>1)url.searchParams.set('page',String(page));
    const data=await api.get(url.href,token,kind);
    if(data.success!==true||(data.errors?.length??0)!==0)refuse(kind,'FAIL_API',cfCode(data));
    const rows=kind==='r2'?data.result?.buckets:kind==='workers_native'?(data.result?.workers??data.result):data.result;
    if(!Array.isArray(rows)||rows.length>100)refuse(kind,'FAIL_PAGINATION');
    for(const row of rows){
      const name=row?.name??(kind==='workers_scripts'?row?.id:undefined);
      const id=row?.uuid??row?.id??name;
      if(typeof name!=='string'||!name||typeof id!=='string'||!id||ids.has(id))refuse(kind,'FAIL_PAGINATION');ids.add(id);
    }
    count+=rows.length;
    const info=data.result_info??{};if(!object(info))refuse(kind,'FAIL_PAGINATION');
    for(const key of ['count','total_count','page','per_page','total_pages'])if(own(info,key)&&!integer(info[key]))refuse(kind,'FAIL_PAGINATION');
    if((own(info,'count')&&info.count!==rows.length)||(own(info,'page')&&info.page!==page)||
      (own(info,'per_page')&&(info.per_page<1||info.per_page>100||rows.length>info.per_page)))refuse(kind,'FAIL_PAGINATION');
    if(own(info,'total_count')){if(total!==null&&total!==info.total_count)refuse(kind,'FAIL_PAGINATION');total=info.total_count;}
    if(own(info,'total_pages')){if(pages!==null&&pages!==info.total_pages)refuse(kind,'FAIL_PAGINATION');pages=info.total_pages;}
    if(pages===0&&(count!==0||(total!==null&&total!==0)))refuse(kind,'FAIL_PAGINATION');
    if((total!==null&&count>total)||(pages!==null&&page>Math.max(1,pages)))refuse(kind,'FAIL_PAGINATION');
    if(own(info,'cursors')&&(!object(info.cursors)||Object.keys(info.cursors).some(k=>!['before','after'].includes(k))))refuse(kind,'FAIL_PAGINATION');
    const nexts=[info.cursor,info.cursors?.after,data.result?.cursor].filter(v=>v!==undefined&&v!==null&&v!=='');
    if(nexts.some(v=>typeof v!=='string'||v.length>1024)||new Set(nexts).size>1)refuse(kind,'FAIL_PAGINATION');
    const next=nexts[0]??null;
    const flags=[info.has_more,info.truncated,info.is_truncated,data.result?.has_more,data.result?.truncated,data.result?.is_truncated].filter(v=>v!==undefined);
    if(flags.some(v=>typeof v!=='boolean'))refuse(kind,'FAIL_PAGINATION');
    const more=flags.includes(true);
    if(next!==null){if(cursors.has(next)||!rows.length||(total!==null&&count===total)||(pages!==null&&page===pages))refuse(kind,'FAIL_PAGINATION');cursors.add(next);cursor=next;page++;continue;}
    if((total!==null&&count<total)||(pages!==null&&page<pages)||more){if(!rows.length)refuse(kind,'FAIL_PAGINATION');cursor=null;page++;continue;}
    if((total!==null&&count!==total)||(more&&total===count))refuse(kind,'FAIL_PAGINATION');
    if(total!==null||pages!==null||rows.length<(info.per_page??100))return count;
    if(!rows.length)return count;cursor=null;page++;
  }
}

export async function probe({env,event,fetchImpl=fetch,now=Date.now,emit=()=>{}}){
  const head=scope(env,event);
  if(env.PREFLIGHT_GUARD_HEAD!==head||env.PREFLIGHT_USED!=='1'||!/^\d{13}$/.test(env.PREFLIGHT_STARTED_MS??''))refuse('lease','FAIL_LEASE');
  const api=client({fetchImpl,now,started:Number(env.PREFLIGHT_STARTED_MS),used:1});
  const token=env.CLOUDFLARE_API_TOKEN,account=env.CLOUDFLARE_ACCOUNT_ID;
  if(typeof token!=='string'||!token.trim()||typeof account!=='string'||!account)refuse('credentials','FAIL_MISSING');
  if(!/^[a-f0-9]{32}$/.test(account)||/[\r\n]/.test(token)||token!==token.trim()||token.length>4096)refuse('credentials','FAIL_FORMAT');
  // AccountSettings/Membership permission is deliberately not requested.
  const prefix=`https://api.cloudflare.com/client/v4/accounts/${account}`;
  for(const kind of Object.keys(FAMILIES))emit(receipt(kind,'PASS',await inventory(api,prefix,token,kind)));
  emit(receipt('complete','PASS',api.used));return api.used;
}

async function main(){
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  try{
    const bytes=readFileSync(process.env.GITHUB_EVENT_PATH);if(bytes.length>MAX_BYTES)refuse('scope','FAIL_INPUT');
    const event=JSON.parse(bytes.toString('utf8'));
    if(process.argv.length!==3)refuse('scope','FAIL_INPUT');
    if(process.argv[2]==='--guard'){
      const value=await guard({env:process.env,event,emit});
      if(!process.env.GITHUB_OUTPUT)refuse('lease','FAIL_INPUT');
      appendFileSync(process.env.GITHUB_OUTPUT,`ready=true\nstarted_ms=${value.started}\nhead=${value.head}\nused=${value.used}\n`);
    }else if(process.argv[2]==='--probe')await probe({env:process.env,event,emit});
    else refuse('scope','FAIL_INPUT');
  }catch(error){emit(receipt(error instanceof Refusal?error.stage:'preflight',error instanceof Refusal?error.status:'FAIL_INTERNAL',null,error instanceof Refusal?error.cf_code:null));process.exitCode=1;}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)await main();
