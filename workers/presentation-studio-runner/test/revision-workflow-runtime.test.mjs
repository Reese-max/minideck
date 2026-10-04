import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  let source;
  if (specifier === "cloudflare:workers") source = "export class WorkflowEntrypoint { constructor(_ctx,env) { this.env=env; } }";
  if (specifier === "@cloudflare/containers") source = "export class Container {} export const getContainer=()=>globalThis.__revisionRuntime.container;";
  if (context.parentURL?.endsWith("/workflow.ts")) {
    if (specifier === "./input") source = "export const loadJobInput=async()=>structuredClone(globalThis.__revisionRuntime.input);";
    if (specifier === "./mcp-service") source = "export const completeJob=async(_env,_job,result)=>globalThis.__revisionRuntime.complete(result); export const completeFailure=async(_env,_job,error)=>{throw error};";
    if (specifier === "./judges") source = "export const runJudges=async(_env,_input,result)=>{globalThis.__revisionRuntime.judges++; return result};";
  }
  if (source) return { url: dataModule(source), shortCircuit: true };
  if (context.parentURL?.endsWith(".ts") && /^\.\.?\/[^.]+$/.test(specifier)) specifier += ".ts";
  return nextResolve(specifier, context);
} });
const { PresentationWorkflow } = await import("../src/workflow.ts");
hooks.deregister();

async function run(patch, { planner = false, scope = ["s1"] } = {}) {
  const spec = { slides: [{ id:"s1",keyMessage:"Original one" },{ id:"s2",keyMessage:"Original two" }] };
  const input = { type:"revision",jobId:"runtime-revision",projectId:"runtime-project",spec,sourceMap:{claims:[]},sources:[],profile:{},
    payload:planner?{instruction:"Synthetic targeted revision"}:{specPatch:patch}, changedSlides:scope, parentVersionId:"v1" };
  const state = { input, renders:[],judges:0,completions:[],provider:0,
    container:{async runJob(value) {state.renders.push(structuredClone(value)); return {status:"succeeded",jobId:value.jobId,
      version:{spec:value.spec,changedSlides:value.changedSlides,parentVersionId:value.parentVersionId,audit:{deterministic:{claimIntegrity:true}}}};}},
    complete(result) {state.completions.push(structuredClone(result));return result;} };
  const original = globalThis.fetch;
  globalThis.__revisionRuntime = state;
  globalThis.fetch = async (url) => {assert.equal(String(url),"https://synthetic-planner.invalid/");state.provider++;
    return Response.json({choices:[{message:{content:JSON.stringify(patch)}}]});};
  try {
    const env = {CF_AI_ROUTER_URL:"https://synthetic-planner.invalid/",CF_AI_ROUTER_API_KEY:"synthetic-test-value"};
    const workflow = new PresentationWorkflow({},env);
    const step = {async do(_name,...args) {return args.at(-1)();}};
    const result = await workflow.run({payload:{job:{id:input.jobId,type:"revision"}}},step);
    assert.deepEqual(input.spec,spec,"stored source fixture remains unchanged");
    return {state,result,spec};
  } finally {globalThis.fetch=original;delete globalThis.__revisionRuntime;}
}

for (const [name,patch] of [
  ["out-of-scope s2",{slides:[{id:"s2",keyMessage:"Unauthorized two"}]}],
  ["unknown slide",{slides:[{id:"s99",keyMessage:"Unknown"}]}],
  ["unsupported field",{slides:[{id:"s1",variants:[{}]}]}],
  ["unknown claim",{slides:[{id:"s1",claims:["missing"]}]}],
]) test(`actual Workflow rejects supplied ${name} before render and Judge`,async()=>{
  const {state,result}=await run(patch);
  assert.equal(result.status,"blocked");assert.equal(state.renders.length,0);assert.equal(state.judges,0);assert.equal(state.provider,0);
  assert.equal(state.completions.length,1);assert.equal(result.version,undefined);
});

test("actual Workflow completes legal targeted supplied patch with truthful changedSlides",async()=>{
  const {state,result}=await run({slides:[{id:"s1",keyMessage:"Revised one"}]},{scope:["s1","s2"]});
  assert.equal(result.status,"succeeded");assert.equal(state.renders.length,1);assert.equal(state.judges,1);assert.equal(state.provider,0);
  assert.equal(result.version.spec.slides[0].keyMessage,"Revised one");assert.equal(result.version.spec.slides[1].keyMessage,"Original two");
  assert.deepEqual(result.version.changedSlides,["s1"]);assert.equal(result.version.parentVersionId,"v1");
  assert.equal(state.renders[0].payload.specPatch,null);
});

test("actual Workflow emits an empty receipt diff for a legal no-op supplied patch",async()=>{
  const {result,state}=await run({slides:[{id:"s1",keyMessage:"Original one"}]});
  assert.equal(state.renders.length,1);assert.deepEqual(result.version.changedSlides,[]);
});

test("actual planner and supplied paths enforce the same scope before render",async()=>{
  const rejected=await run({slides:[{id:"s2",keyMessage:"Unauthorized two"}]},{planner:true});
  assert.equal(rejected.state.provider,1);assert.equal(rejected.state.renders.length,0);assert.equal(rejected.result.status,"blocked");
  const accepted=await run({slides:[{id:"s1",keyMessage:"Revised one"}]},{planner:true});
  assert.equal(accepted.state.provider,1);assert.equal(accepted.state.renders.length,1);
  assert.equal(accepted.result.version.spec.slides[1].keyMessage,"Original two");assert.deepEqual(accepted.result.version.changedSlides,["s1"]);
});
