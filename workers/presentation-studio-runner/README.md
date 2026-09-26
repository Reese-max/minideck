# Presentation Studio Dashi Runner

This Worker is the Phase B execution layer for Presentation Studio v2.0.
It claims queued jobs from the existing `presentation-studio-mcp` Worker through
a private service binding, starts one durable Workflow per job, and executes the
allowlisted Dashi commands inside a Cloudflare Container.

The public MCP Worker remains the only ChatGPT-facing surface. This Worker does
not expose a shell, SQL endpoint, arbitrary R2 access, or a public job endpoint.
The container can upload only fixed artifact kinds through the private outbound
host `presentation-studio.internal`; the Worker derives the R2 key from the
running job and never accepts a caller-supplied key.

## Local checks

```bash
npm ci
npx wrangler types
npm run check
npx wrangler deploy --dry-run
```

The Docker image is intentionally pinned to `dashi-ppt-skill@0.4.11`, Node 22,
Chromium, and CJK fonts. The image uses Dashi as a distributed package and must
be operated in accordance with Dashi's AGPL-3.0 and any separate export-engine
license terms. This repository does not copy Dashi source into the Worker.

## Deployment

Use the root GitHub Actions workflow for a manual preview or production deploy.
Preview has polling disabled so it cannot consume production jobs. Production
deployment is intentionally manual because Wrangler activates the Worker before
the container image rollout is complete; run the end-to-end smoke test only after
the container reaches a healthy state.

Set the same `CF_AI_ROUTER_API_KEY` Worker secret when you want the optional
planner fallback and the independent visual/factual Judges. The runner calls
the existing OpenAI-compatible `cf-ai-router` endpoint; planner context and
Judge claim context exclude records marked sensitive. Without that secret, a
ChatGPT-first `slideSpec` still renders normally, while a project without a
spec and a revision without a supplied `specPatch` fail closed. Every render
without Judges is also held for review.

When a revision contains only an instruction, the Runner's isolated revision
planner can produce a validated, targeted patch if the router secret is set.
It may touch only existing slide IDs and verified non-sensitive claim IDs;
otherwise use `specPatch` from ChatGPT directly.

For deployment, configure the shared `PRESENTATION_RUNNER_TOKEN` secret on
both Workers. Configure `CF_AI_ROUTER_API_KEY` only on the runner; it is never
exposed through the public MCP tool contract.

The Dashi render result is passed to two separate Judge calls. A technically
rendered deck is reviewable, but cannot be approved or exported until both
independent Judge results are present, pass, and are recorded in the audit
contract.

The runner checks claim bindings and literal sensitive claim text before it
starts Dashi or sends revision and Judge prompts. Unknown or sensitive bindings
block the job with a generic error. Sensitive claim text is also removed from
the source map copied into the Dashi container. A second check on generated
goal and HTML content runs before artifact upload.
