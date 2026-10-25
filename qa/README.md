# Fixed PR44 stored-fixture Preview QA

This tooling has no production entry point. Canonical application files remain
byte-identical to published `d082a767` / tree `4e7f083a`; the controller rejects
drift before credentials. The dedicated workflow runs only an owner-triggered,
same-repository open draft PR44 on `feature/fix-new-issues-38-41`, with a fresh
live PR-head lease before resource writes. It needs no default-branch merge.

The footprint is two new native Worker Preview parents, two freshly created
D1 databases and one dedicated R2 bucket, derived from run/attempt. Metadata
inventory must be complete and prove name absence; fresh-create/readback IDs
bind subsequent schema and fixture writes. No supplied existing resource IDs,
shared bindings, Runner, Workflow, Durable Object, container, provider key,
GitHub OAuth secret, account billing change or rotating OAuth token is used.
Only the existing infrastructure account API credential is passed inside CI.
GET success does not certify create/write permission; any403 stops the path.

Pinned QA-only Wrangler4.135 uses `preview --ignore-base-config` and captures
the real immutable deployment URL/ID. This protocol follows the exercised Flux
QA approach; no production deployment or ordinary versions-promotion command
is used. Source/helper/config/schema hashes and the CLI context bind the
receipt. The CLI does not expose a separately verifiable uploaded payload byte
digest; that digest is not asserted. `CF_VERSION_METADATA.id` is recorded as a
bounded runtime identifier, without guessing equivalence to deployment ID.

Each fresh D1 gets only a QA control table in addition to canonical schema.
The first upload has an inactive gate and denies root/static/SPA/OAuth paths,
even with the correct key. A random256-bit CI-only key is SHA256-hashed in D1;
its plaintext never enters argv, source, config, logs or artifacts (only the
GitHub masking directive/private runner state). Gate activation checks exact
run/source/product tree, integer times/counters and15-minute expiry. Assets
explicitly run through the wrapper first. Both contexts have the outer QA key;
anonymous means no application project token.

The fixed site/MCP admission budgets are140/60 requests (200 total); the harness
stops at130/50 to reserve cleanup slots. Direct account API operations have a
separately persisted100-request budget, with30 reserved for cleanup. Bounded
controller denial probes are counted separately; native CLI internal upload
requests are not instrumented or falsely included in those totals. Two upload
commands are normally used, with a hard four-command maximum. The CI job bound
is20minutes; remote steps have5/4/4-minute limits, reserving cleanup time. No
zero-cost monetary guarantee is made for existing-plan Worker/D1/R2 usage.
The job clock starts before checkout/setup. Admission refuses any new remote
write when fewer than14minutes remain (5+4+4+1 for phase/artifact bounds), so
slow setup cannot silently consume the cleanup reserve. Retirement still runs
without granting any new admission when the head/clock has moved on.

Actual HTTP/Chromium exercise stored publication/save/rollback/unpublish,
player navigation/script blocking, brief suffix, capped optimize and chat.
Chat/optimize receive the canonical missing-key SSE error; successful AI
revision is not claimed. One explicitly labeled QA-only fault throws during
the owned authenticated project's quota INSERT before streaming; all other
queries use native D1. It tests refund/release, not a real Cloudflare outage,
and never replaces SSE/provider responses. MCP uses short-lived synthetic
hash-only tokens, two numeric fixture subjects, owner idempotency and actual
revocation while the outer run gate remains active. No real GitHub OAuth or
Workflow is claimed.

After closing the browser, cleanup removes exact owned project/token/
idempotency/profile rows and keys, including narrowly recognized partial
source-map writes; foreign/unknown leftovers fail the clean claim. Cleanup
then unconditionally revokes the live D1 gate and probes every captured
immutable root/static/SPA/OAuth URL. Old immutable deployments consult the
same revoked row and deny. Cloud resources/tables and an inactive audit row
remain, per AGENTS; resources are never deleted. Exhausted/expired gates may
prevent data cleanup: report incomplete and still attempt account-level gate
revocation. SIGKILL/hard timeout cannot guarantee cleanup; hard expiry remains
a bounded fallback, with no successful retirement claim absent proof.

Local checks: `node --test qa/*.test.mjs`, `node qa/local-runtime.mjs` with
Chromium installed, and the required root `npm run check`. Local rehearsal
uses the same adapters/harness with actual workerd/D1/R2 and Chromium and
blocks outbound transport. It is not a deployed Cloudflare Preview.
