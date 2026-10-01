# Presentation Studio MCP Worker

The MCP boundary of Presentation Studio v2.0.0. This is a stateless remote MCP Worker
with D1-backed project/job state and R2-backed source objects. It is the
controlled boundary for ChatGPT; it does not execute Dashi or arbitrary
Cloudflare operations in the request path.

## Contract

The /mcp endpoint exposes exactly eight high-level tools:

- list_presentation_profiles
- create_presentation
- get_presentation
- request_presentation_revision
- compare_presentation_versions
- approve_presentation
- export_presentation
- delete_presentation

All project reads and writes are scoped to the authenticated OAuth owner.
Idempotency records are namespaced by the same owner, so a cached result can
only be replayed to the owner that created it, and write tools re-authorize
ownership before serving any cached response.
create_presentation accepts a ChatGPT-first slideSpec, inline text or base64
source content, and claim-to-source mappings. The Worker stores source objects
under a generated project prefix and only stores the corresponding metadata in
D1.

create_presentation, revision, and export operations create D1 jobs. The
separate presentation-studio-runner Worker claims these jobs through a private
service binding, runs Dashi in a Cloudflare Container, and writes versions,
audits, and artifacts back to D1/R2. The MCP Worker never renders inline.
approve_presentation fails closed until the recorded audit satisfies the
quality contract.

The runner-only endpoints are POST /internal/jobs/claim and
POST /internal/jobs/complete. They require the PRESENTATION_RUNNER_TOKEN
Bearer secret and are not registered as MCP tools. Claim leases expire after
60 minutes so the Workflow/Container execution window cannot create duplicate
work; completion accepts only constrained render/export result shapes.

## Local checks

Run npm ci, npm run check, and npx wrangler deploy --dry-run from this
directory.

Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and the shared
PRESENTATION_RUNNER_TOKEN as Worker secrets; set (in production)
MCP_PUBLIC_ORIGIN as a Worker variable. OAuth uses
authorization code plus PKCE (S256), and the Worker stores only hashes of
authorization codes and tokens.

## Deployment

Use this directory as the Wrangler working directory and run npx wrangler
deploy. The repository also provides the manually triggered
presentation-studio-mcp-deploy workflow: preview uploads a non-production
version, while production requires the confirmation input and the production
environment approval.

The configured D1 and R2 bindings point to the existing presentation-studio
database and minideck bucket; no database or bucket is created by this Worker.
