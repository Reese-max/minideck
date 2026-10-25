// QA-only failure adapter. Production UI/handler are imported unchanged.
import product from '../src/worker.js';
import {admit,privateResponse} from './gate.mjs';
import {fixtureRequest} from './fixtures.mjs';
export default {async fetch(request,env,ctx) {
  const denied=await admit(request,env,Date.now(),140);if(denied)return denied;
  try {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/__qa/'))return privateResponse(await fixtureRequest(request,env,'site'));
    const bound={DB:env.DB,BUCKET:env.BUCKET,ASSETS:env.ASSETS,
      LIMIT_IP_PROJECTS:'0',LIMIT_GLOBAL_PROJECTS:'0',LIMIT_GLOBAL_TEXT:'20',LIMIT_GLOBAL_IMAGES:'0',
      LIMIT_PROJECT_REVISES:'20',LIMIT_PROJECT_IMAGES:'0',LIMIT_PROJECT_RETRIES:'3'};
    let injected=false;
    const owned=`qa-${env.QA_RUN}`, fault=request.headers.get('x-minideck-qa-fault');
    // Authorization still runs in the unchanged canonical handler first. Only
    // this exact run's generate/revise request can hit one pre-stream SQL fault.
    if(fault==='quota-insert'&&url.pathname===`/api/projects/${owned}/generate`) {
      bound.DB={prepare(sql){const stmt=env.DB.prepare(sql);if(!/^INSERT INTO quotas\(/.test(sql.trim()))return stmt;
        return {bind(...args){stmt.bind(...args);return this;},async run(){injected=true;throw new Error('Owned QA quota INSERT exception');}};}};
    }
    const response=/^\/(api|img|p)(\/|$)/.test(url.pathname)?await product.fetch(request,bound,ctx):await env.ASSETS.fetch(request);
    const wrapped=privateResponse(response);
    if(injected)wrapped.headers.set('X-Minideck-QA-Fault','synthetic-prestream-quota-insert');
    return wrapped;
  } catch {return privateResponse(new Response('QA handler failed',{status:500}));}
}};
