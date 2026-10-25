// Fixed to the already reviewed/passing application; QA is not a deployment API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PRODUCT_SHA = 'd082a767f47af50dc3a50ba2ea54f21deaae90f2';
export const PRODUCT_TREE = '4e7f083aa5208fb4d74b5c1091d290d0e5e507e3';
export const REPO = 'Reese-max/minideck';
export const BRANCH = 'feature/fix-new-issues-38-41';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function ensureCleanupWindow(env,now=Date.now()) {
  const start=Number(env.MINIDECK_QA_JOB_STARTED_AT);
  assert.ok(Number.isSafeInteger(start)&&start>0&&start<=now,'Missing/invalid CI job start');
  // Entire job20m; reserve prepare5+verify4+cleanup4+artifact1 before writes.
  assert.ok(start+20*60000-now>=14*60000,'Insufficient job window; no new cloud writes');
  return {jobStartedAt:start,remainingMs:start+20*60000-now,cleanupReserveMs:4*60000};
}
export function runIdentity(id, attempt) {
  assert.match(String(id), /^[1-9][0-9]{0,19}$/); assert.match(String(attempt), /^[1-9][0-9]{0,3}$/);
  const run = `${id}-${attempt}`, scope = `minideck-qa-${digest(run).slice(0,12)}`;
  return { run, scope, site: `${scope}-site`, mcp: `${scope}-mcp`, siteDb: `${scope}-site-db`, studioDb: `${scope}-studio-db`, bucket: `${scope}-assets` };
}
export function validateAdmission(env, event, pr, checkout) {
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request'); assert.equal(env.GITHUB_REPOSITORY, REPO);
  assert.equal(env.GITHUB_ACTOR, 'Reese-max'); assert.equal(env.GITHUB_TRIGGERING_ACTOR, 'Reese-max');
  for (const p of [event.pull_request, pr]) {
    assert.equal(p?.number,44); assert.equal(p.state,'open'); assert.equal(p.draft,true);
    assert.equal(p.user.login,'Reese-max'); assert.equal(p.head.repo.full_name,REPO); assert.equal(p.head.ref,BRANCH);
    assert.equal(p.base.ref,'main'); assert.equal(p.head.sha,checkout);
  }
  assert.match(checkout,/^[a-f0-9]{40}$/);
  return {...runIdentity(env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT),sourceSha:checkout};
}
export function validateSource(base=root) {
  const git=(...args)=>execFileSync('git',args,{cwd:base,encoding:'utf8'}).trim();
  assert.equal(git('rev-parse',`${PRODUCT_SHA}^{tree}`),PRODUCT_TREE);
  const files=git('ls-tree','-r','--name-only',PRODUCT_SHA).split('\n');
  assert.ok(files.length>100);
  for (const file of files) {
    const expected=execFileSync('git',['show',`${PRODUCT_SHA}:${file}`],{cwd:base,maxBuffer:8*1024*1024});
    assert.equal(digest(readFileSync(resolve(base,file))),digest(expected),`Frozen application changed: ${file}`);
  }
  const added=git('ls-files').split('\n').filter(file=>!files.includes(file));
  assert.ok(added.every(file=>file.startsWith('qa/')||['.github/workflows/stored-preview-qa.yml','.github/workflows/cf-readonly-preflight.yml','.github/scripts/cf-readonly-preflight.mjs'].includes(file)),'Unexpected non-QA source addition');
  assert.equal(git('status','--porcelain'),'','Require clean reviewed QA checkout');
  return {sha:PRODUCT_SHA,tree:PRODUCT_TREE,files:files.length};
}
export function sourceProvenance(base=root) {
  const files=execFileSync('git',['ls-files','-z'],{cwd:base,encoding:'utf8'}).split('\0').filter(Boolean);
  return {productSha:PRODUCT_SHA,productTree:PRODUCT_TREE,sha256:Object.fromEntries(files.map(file=>[file,digest(readFileSync(resolve(base,file)))])),
    uploadBinding:'Pinned CLI4.135 actual upload context + immutable deployment URL/ID; source/entry/config hashes recorded. Uploaded payload byte digest is not exposed by this CLI and is not independently asserted.'};
}
export function immutableOrigin(value,id,worker) {
  assert.match(id,/^(?:[a-f0-9]{8}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
  assert.match(worker,/^minideck-qa-[a-f0-9]{12}-(site|mcp)$/);
  const u=new URL(value),prefix=`${id.slice(0,8)}-${worker}.`;
  assert.equal(u.protocol,'https:');assert.equal(u.pathname,'/');
  assert.ok(!u.username&&!u.password&&!u.port&&!u.search&&!u.hash);
  assert.ok(u.hostname.startsWith(prefix)); assert.match(u.hostname.slice(prefix.length),/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/);
  return u.origin;
}
// Protocol adapted from the independently exercised Flux native Preview gate.
export function parsePreview(output,{worker,name,config,createdAt,now=Date.now()}) {
  assert.ok(Buffer.byteLength(output)<=16384);
  const lines=output.split(/\r?\n/).filter(x=>x.trim());assert.equal(lines.length,2);
  const [session,p]=lines.map(x=>JSON.parse(x));
  assert.equal(session.type,'wrangler-session');assert.equal(session.version,1);assert.equal(session.wrangler_version,'4.135.0');
  assert.deepEqual(session.command_line_args,['preview','--config',config,'--worker-name',worker,'--name',name,'--ignore-base-config','--json']);
  assert.equal(p.type,'preview');assert.equal(p.version,1);assert.equal(p.preview_name,name);
  if(p.worker_name!==undefined)assert.equal(p.worker_name,worker);
  for(const stamp of [session.timestamp,p.timestamp]) { const t=Date.parse(stamp);assert.ok(Number.isFinite(t)&&t>=createdAt&&t<=now+5000&&now-t<=300000); }
  assert.equal(p.deployment_urls?.length,1);assert.ok(Array.isArray(p.preview_urls)&&p.preview_urls.length<=4);
  const origin=immutableOrigin(p.deployment_urls[0],p.deployment_id,worker);
  assert.ok(!p.preview_urls.some(x=>new URL(x).origin===origin));
  return {origin,deploymentId:p.deployment_id,previewId:p.preview_id,worker};
}
