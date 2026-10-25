// QA gate does not replace application Bearer authentication.
import product from '../workers/presentation-studio-mcp/src/index.ts';
import {admit,privateResponse} from './gate.mjs';
import {fixtureRequest} from './fixtures.mjs';
export default {async fetch(request,env,ctx) {
  const denied=await admit(request,env,Date.now(),60);if(denied)return denied;
  try {
    if(new URL(request.url).pathname.startsWith('/__qa/'))return privateResponse(await fixtureRequest(request,env,'mcp'));
    // No OAuth/provider/runner Secret is passed, even if unexpectedly present.
    return privateResponse(await product.fetch(request,{DB:env.DB,BUCKET:env.BUCKET,ARCHITECTURE_VERSION:'2.0.0',
      DEFAULT_PROFILE_ID:`${env.QA_SCOPE}-profile`,R2_PREFIX:`${env.QA_SCOPE}/`,
      PRESENTATION_RUNNER_STATUS:'pending',MCP_ALLOWED_HOSTNAMES:new URL(request.url).hostname},ctx));
  } catch {return privateResponse(new Response('QA handler failed',{status:500}));}
}};
