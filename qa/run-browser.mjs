import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {root,digest,PRODUCT_TREE} from './contract.mjs';
import {fixtureDeck} from './fixtures.mjs';
export async function runBrowser(s) {
  const result={controls:[],errors:[],blockedOrigins:[],requests:{site:0,mcp:0},fixtureBytes:0,actualProviderCalls:0,providerResponsesMocked:0,
    applicationTransport:'canonical handlers; only explicitly marked pre-stream quota INSERT exception is synthetic',realOAuth:false,realWorkflow:false};
  const control=async(name,run)=>{await run();result.controls.push(name);console.log('PASS '+name);};
  const budget=kind=>{assert.ok(++result.requests[kind]<=(kind==='site'?130:50),'Runtime test budget reserved for cleanup');};
  const f=async(kind,path,init={})=>{budget(kind);return fetch(s.previews[kind].origin+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'x-minideck-qa':s.gate,...init.headers}});};
  const get=async(kind,path,init={})=>{const r=await f(kind,path,init);assert.equal(r.status,200);return r.json();};
  const post=async(kind,path,data,headers={})=>get(kind,path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
  const project=`qa-${s.identity.run}`,headers={'X-Project-Token':s.projectToken};
  let browser;
  try {
    await control('immutable deployed identities and frozen static bytes match upload context',async()=>{
      for(const kind of ['site','mcp']){const status=await get(kind,'/__qa/status');assert.equal(status.run,s.identity.run);assert.equal(status.sourceSha,s.identity.sourceSha);assert.equal(status.productTree,PRODUCT_TREE);assert.equal(status.kind,kind);assert.match(status.version,/^[a-zA-Z0-9_-]{1,128}$/);result[kind+'RuntimeVersion']=status.version;}
      result.versionBinding='Immutable deployment URL/ID comes from actual pinned CLI upload context; CF_VERSION_METADATA.id is independently recorded, not assumed equal to deployment ID.';
      for(const file of ['index.html','app.js','app.css','play.html','vendor/pptxgen.bundle.js','vendor/html-to-image.js']){
        const r=await f('site','/'+file);assert.equal(r.status,200);assert.equal(digest(Buffer.from(await r.arrayBuffer())),digest(readFileSync(resolve(root,'public',file))));}
    });
    const seed=await post('site','/__qa/seed',{projectTokenHash:digest(s.projectToken)});assert.equal(seed.projectId,project);assert.ok(seed.bytes<=1048576);result.fixtureBytes+=seed.bytes;
    await post('mcp','/__qa/seed',{tokenHashes:s.mcpTokens.map(digest)});
    await control('canonical authorization precedes the explicit owned pre-stream fault',async()=>{
      const denied=await f('site',`/api/projects/${project}/generate`,{method:'POST',headers:{'content-type':'application/json','X-Project-Token':'b'.repeat(64),'x-minideck-qa-fault':'quota-insert'},body:'{}'});
      assert.equal(denied.status,403);assert.equal(denied.headers.get('X-Minideck-QA-Fault'),null);
      const before=await get('site','/__qa/state');
      for(let i=0;i<2;i++){const r=await f('site',`/api/projects/${project}/generate`,{method:'POST',headers:{...headers,'content-type':'application/json','x-minideck-qa-fault':'quota-insert'},body:'{}'});
        assert.equal(r.status,500);assert.equal(r.headers.get('X-Minideck-QA-Fault'),'synthetic-prestream-quota-insert');await r.arrayBuffer();
        const after=await get('site','/__qa/state');assert.equal(after.project.status,'ready');assert.deepEqual(after.quotas,before.quotas);}
    });
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});result.chromium=browser.version();
    const owner=await browser.newContext({serviceWorkers:'block',extraHTTPHeaders:{'X-Minideck-QA':s.gate},viewport:{width:1440,height:1100}});
    const anon=await browser.newContext({serviceWorkers:'block',extraHTTPHeaders:{'X-Minideck-QA':s.gate}});
    for(const context of [owner,anon])await context.route('**/*',async route=>{const url=new URL(route.request().url());
      if(url.origin!==s.previews.site.origin){result.blockedOrigins.push(url.origin);await route.abort();return;}
      budget('site');await route.continue();});
    await owner.addInitScript(({project,token})=>sessionStorage.setItem(`minideck:project-token:${project}`,token),{project,token:s.projectToken});
    const page=await owner.newPage(),publicPage=await anon.newPage();for(const p of [page,publicPage])p.on('pageerror',e=>result.errors.push(e.name));
    await page.goto(s.previews.site.origin+'/#p='+project);await page.waitForFunction(()=>document.querySelector('[data-preview-version]').textContent.includes('v2'));
    const idle=()=>page.waitForFunction(()=>document.querySelector('#brief-form').getAttribute('aria-busy')==='false');
    await control('real nested native player navigates stored slides and denies inline deck script',async()=>{
      await page.locator('#btn-player-preview').click();const player=page.frameLocator('#player-preview iframe');
      await player.locator('#play-counter').filter({hasText:'1 / 40'}).waitFor();await player.locator('#play-stage').press('ArrowRight');
      await player.locator('#play-counter').filter({hasText:'2 / 40'}).waitFor();
      assert.equal(await player.frameLocator('#play-deck').locator('html').evaluate(()=>globalThis.qaDeckScriptRan===true),false);await page.locator('#player-preview button').click();
    });
    await control('native chat issues actual revision HTTP and missing key fails/refunds/releases without provider',async()=>{
      const before=await get('site','/__qa/state');
      await page.locator('#chat-input').fill('Owned fixture revision; no live provider');const wait=page.waitForResponse(r=>r.url().includes(`/api/projects/${project}/revise`));await page.locator('#chat-submit').click();
      const r=await wait;assert.equal(r.status(),200);assert.match(r.headers()['content-type'],/text\/event-stream/);await idle();
      // The canonical UI parses the actual SSE error. Chromium does not retain
      // this streamed response for CDP getResponseBody after the reader closes.
      await page.getByText('伺服器未設定 MiniMax API key',{exact:false}).first().waitFor();
      result.missingKeySseObservation='actual canonical UI SSE parser displayed the missing-key error; no response interception/replacement';
      const after=await get('site','/__qa/state');assert.equal(after.project.status,'ready');assert.equal(after.project.published_version,1);
      assert.deepEqual(after.quotas.filter(x=>!x.scope.endsWith(':retries')),before.quotas.filter(x=>!x.scope.endsWith(':retries')));
      assert.equal(after.quotas.find(x=>x.scope.endsWith(':retries')).count,1);
    });
    await control('one-click optimize caps real posted payload at1000 and avoids413',async()=>{
      const raw=await page.evaluate(()=>{const report=MD.audit.run(document.querySelector('#deck-frame').contentDocument);return{count:report.warns.length,characters:[...report.warns.map(x=>x.detail).join('\n')].length};});
      assert.ok(raw.count>=40&&raw.characters>1000,'Owned real DOM must reproduce the original long-WARN trigger');result.unboundedWarnCharacters=raw.characters;result.warnCount=raw.count;
      const wait=page.waitForResponse(r=>r.url().includes(`/api/projects/${project}/revise`));await page.locator('#btn-optimize').click();const r=await wait;
      const content=r.request().postDataJSON();assert.ok([...content.message].length>0&&[...content.message].length<=1000);assert.equal(r.status(),200);result.optimizeCharacters=[...content.message].length;await idle();
    });
    await control('explicit stored publish/save/rollback keep anonymous snapshot pinned until publish',async()=>{
      assert.equal((await publicPage.goto(s.previews.site.origin+'/p/'+project)).status(),200);assert.match(await publicPage.locator('#deck-source').inputValue(),/FIXTURE_V1/);
      await page.locator('#btn-publish').click();await page.locator('#publication-feedback').filter({hasText:'已發布 v2'}).waitFor();
      await publicPage.reload();assert.match(await publicPage.locator('#deck-source').inputValue(),/FIXTURE_V2/);
      const html=fixtureDeck('FIXTURE_V3');result.fixtureBytes+=Buffer.byteLength(html);assert.ok(result.fixtureBytes<=1048576);
      await post('site',`/api/projects/${project}/deck`,{html},headers);assert.equal((await get('site','/__qa/state')).project.published_version,2);
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#btn-publish').disabled);await page.locator('button[data-version="1"]').click();await idle();
      const state=await get('site','/__qa/state');assert.ok(state.project.current_version>3);assert.equal(state.project.published_version,2);
      await publicPage.reload();assert.match(await publicPage.locator('#deck-source').inputValue(),/FIXTURE_V2/);
      await page.locator('#btn-unpublish').click();await page.locator('#publication-feedback').filter({hasText:'已下線'}).waitFor();assert.equal((await publicPage.reload()).status(),404);
    });
    await control('native maximum brief and page suffix controls remain valid',async()=>{
      assert.equal(await page.locator('#brief-input').evaluate(x=>x.maxLength),1989);await page.locator('#brief-input').fill('字'.repeat(1989));
      assert.equal(await page.locator('#brief-input').evaluate(x=>x.checkValidity()),true);await page.locator('#page-count').selectOption('5');assert.equal(await page.locator('#brief-input').evaluate(x=>x.maxLength),1990);
    });
    let rpcId=0;s.projects=[];
    const rpc=async(owner,method,params={})=>{
      const r=await f('mcp','/mcp',{method:'POST',headers:{authorization:'Bearer '+s.mcpTokens[owner],'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
      assert.equal(r.status,200);const text=await r.text();return r.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').find(x=>x.startsWith('data: ')).slice(6)):JSON.parse(text);
    };
    const payload=x=>{assert.equal(x.error,undefined);assert.ok(!x.result.isError);return JSON.parse(x.result.content[0].text);};
    await control('actual MCP owner-scoped idempotency and foreign read denial use fresh D1/R2',async()=>{
      assert.equal((await rpc(0,'tools/list')).result.tools.length,8);
      const args={title:'Owned QA project',brief:'Stored synthetic intake; do not dispatch',requestedFormats:['html'],idempotencyKey:`qa-${s.identity.run}`};
      const a=payload(await rpc(0,'tools/call',{name:'create_presentation',arguments:args}));s.projects.push(a.projectId);
      assert.equal(payload(await rpc(0,'tools/call',{name:'create_presentation',arguments:args})).projectId,a.projectId);
      const b=payload(await rpc(1,'tools/call',{name:'create_presentation',arguments:args}));s.projects.push(b.projectId);assert.notEqual(a.projectId,b.projectId);
      const denied=await rpc(1,'tools/call',{name:'get_presentation',arguments:{projectId:a.projectId}});assert.equal(denied.result.isError,true);assert.match(denied.result.content[0].text,/PROJECT_NOT_FOUND/);
      await post('mcp','/__qa/revoke-token',{owner:0,tokenHash:digest(s.mcpTokens[0])});
      const revoked=await f('mcp','/mcp',{method:'POST',headers:{authorization:'Bearer '+s.mcpTokens[0],'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'create_presentation',arguments:args}})});
      assert.equal(revoked.status,401);assert.equal((await get('mcp','/__qa/status')).sourceSha,s.identity.sourceSha,'Outer run gate stays active during canonical token revocation test');
    });
    await control('actual deletion removes owned legacy rows and invalidates anonymous URL',async()=>{
      assert.equal((await f('site',`/api/projects/${project}`,{method:'DELETE',headers})).status,200);assert.equal((await get('site','/__qa/state')).project,null);assert.equal((await f('site','/p/'+project)).status,404);
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.blockedOrigins.every(x=>x==='https://challenges.cloudflare.com'));result.ok=true;return result;
  } finally {await browser?.close();}
}
