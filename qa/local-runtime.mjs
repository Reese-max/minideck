// Native local rehearsal of the SAME QA adapters/harness. No account API calls.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,relative,sep,extname} from 'node:path';
import {root,digest,runIdentity,PRODUCT_TREE} from './contract.mjs';
import {ownedStudioSeed} from '../scripts/isolated-preview.mjs';
import {runBrowser} from './run-browser.mjs';
const {Miniflare,convertV4MiniflareOptions}=createRequire(resolve(root,'qa/node_modules/wrangler/package.json'))('miniflare');
const out=resolve(root,'.wrangler/qa-local');await mkdir(out,{recursive:true});
const s={identity:{...runIdentity('12345678','1'),sourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()},createdAt:Date.now(),
  gate:randomBytes(32).toString('hex'),projectToken:randomBytes(32).toString('hex'),mcpTokens:[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],previews:{}};
const result={kind:'local native QA rehearsal; NOT a cloud Preview',head:s.identity.sourceSha,tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),outboundRequests:0};
let mf;const servers=[];
try {
  const modules={};
  for(const kind of ['site','mcp']){
    const config=resolve(out,kind+'.json');await writeFile(config,JSON.stringify({name:'qa-local-'+kind,main:resolve(root,`qa/${kind}-entry.mjs`),compatibility_date:kind==='site'?'2026-07-29':'2026-08-28',compatibility_flags:['nodejs_compat'],...(kind==='site'?{rules:[{type:'Text',globs:['**/*.md'],fallthrough:true}]}:{})}));
    execFileSync(process.execPath,[resolve(root,'qa/node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',config,'--outdir',resolve(out,kind)],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:'pipe'});
    modules[kind]=[{type:'ESModule',path:resolve(out,kind,kind+'-entry.js')}];
    for(const name of await readdir(resolve(out,kind)))if(name.endsWith('.md'))modules[kind].push({type:'Text',path:resolve(out,kind,name)});
  }
  const assets=async request=>{const url=new URL(request.url),p=resolve(root,'public','.'+(url.pathname==='/'?'/index.html':url.pathname)),rel=relative(resolve(root,'public'),p);if(rel==='..'||rel.startsWith('..'+sep))return new Response(null,{status:404});
    try{return new Response(await readFile(p),{headers:{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(p)]||'application/octet-stream')+';charset=utf-8'}});}catch{return new Response(null,{status:404});}};
  mf=new Miniflare(convertV4MiniflareOptions({workers:['site','mcp'].map(kind=>({name:kind,modules:modules[kind],modulesRoot:resolve(out,kind),
    compatibilityDate:kind==='site'?'2026-07-29':'2026-08-28',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'qa-'+kind},r2Buckets:{BUCKET:'qa-shared'},bindings:{QA_RUN:s.identity.run,QA_SOURCE_SHA:s.identity.sourceSha,QA_PRODUCT_TREE:PRODUCT_TREE,QA_SCOPE:s.identity.scope,QA_CREATED_AT:String(s.createdAt),CF_VERSION_METADATA:{id:'owned-local-'+kind+'-version'}},
    serviceBindings:kind==='site'?{ASSETS:assets}:{},outboundService:()=>{result.outboundRequests++;throw new Error('No outbound transport in local QA');}}))}));
  const databases={};
  for(const kind of ['site','mcp']){
    const db=databases[kind]=await mf.getD1Database('DB',kind),schema=await readFile(resolve(root,kind==='site'?'schema.sql':'workers/presentation-studio-mcp/migrations/0001_init.sql'),'utf8');
    const apply=async text=>{for(const sql of text.replace(/^--.*$/gm,'').split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();};
    await apply(schema);await apply(await readFile(resolve(root,'qa/migrations/0001_run_gate.sql'),'utf8'));
    if(kind==='mcp')await apply(ownedStudioSeed({scope:s.identity.scope,siteD1Id:'11111111-1111-4111-8111-111111111111',studioD1Id:'22222222-2222-4222-8222-222222222222',bucket:s.identity.bucket}));
    await db.prepare('INSERT INTO minideck_qa_run VALUES(?1,?2,?3,?4,?5,?6,0,?7)').bind(s.identity.run,digest(s.gate),s.identity.sourceSha,PRODUCT_TREE,s.createdAt,s.createdAt+900000,kind==='site'?140:60).run();
    const fetcher=await mf.getWorker(kind);
    const server=createServer(async(req,res)=>{try{const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;assert.ok(n<=1048576);chunks.push(chunk);}
      const response=await fetcher.fetch(s.previews[kind].origin+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body){for await(const chunk of response.body)res.write(chunk);}res.end();
    }catch{if(!res.headersSent)res.writeHead(500);res.end('Owned local bridge failure');}});
    servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));s.previews[kind]={origin:`http://127.0.0.1:${server.address().port}`,deploymentId:'owned-local-'+kind};
    for(const p of ['/','/app.js','/oauth/register'])assert.equal((await fetch(s.previews[kind].origin+p,{headers:{'x-minideck-qa':s.gate}})).status,401);
    await db.prepare('UPDATE minideck_qa_run SET active=1 WHERE run_id=?1').bind(s.identity.run).run();
  }
  result.browser=await runBrowser(s);
  for(const kind of ['site','mcp']){
    const cleaned=await fetch(s.previews[kind].origin+'/__qa/cleanup',{method:'POST',headers:{'x-minideck-qa':s.gate,'content-type':'application/json'},body:JSON.stringify({projects:s.projects||[],tokenHashes:s.mcpTokens.map(digest)})});
    assert.equal(cleaned.status,200);result[kind+'Cleanup']=await cleaned.json();assert.equal(result[kind+'Cleanup'].clean,true);
    await databases[kind].prepare('UPDATE minideck_qa_run SET active=0 WHERE run_id=?1').bind(s.identity.run).run();
    for(const p of ['/','/app.js','/owned-spa-path','/oauth/register'])assert.equal((await fetch(s.previews[kind].origin+p,{headers:{'x-minideck-qa':s.gate}})).status,401);
  }
  assert.equal(result.outboundRequests,0);result.status='PASS';
}catch(error){result.status='FAIL';result.failure=error.stack;process.exitCode=1;}
finally{for(const server of servers)await new Promise(r=>server.close(r));await mf?.dispose();if(process.env.MINIDECK_LOCAL_QA_REPORT)await writeFile(process.env.MINIDECK_LOCAL_QA_REPORT,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}
