# V2 draft integration — 2026-10-08

The v2 MCP and Runner remain an unadopted feature in draft PR #1. Current
`main@31f7131ae24af9d89287000e8048750e598686a1` contains the legacy MiniDeck
application and does not contain these Workers. This integration is a candidate
for review, not a production release or a completed issue acceptance.

The candidate preserves the selected changes from PR #19 (targeted revision,
complete visual coverage and the sensitive boundary), #29 (immutable GitHub
subject and owner-scoped idempotency), #26 (bounded expired-lease recovery and
attempt fencing), #28 (named-environment bindings) and #20 (numbered SQLite
placeholder handling in the test harness). It also carries PR #24's sensitive
identifier follow-up: private claim rows are omitted from the actual Dashi
source-map file, as they already are from the boundary's safe view.

Integration retains owner authorization and exact approved-version checks
before cached export results, atomic refresh-token rotation, the reserved
revision budget, rollback on a lease that expires during artifact validation,
and derived, attempt-scoped R2 keys for every bounded contact-sheet kind.
Judges now require the current claim attempt's exact preview keys; legacy or
previous-attempt keys fail before image retrieval or provider dispatch.

Failed technical or format-export checks block artifact publication even if a
failed exporter leaves an output file. Revision title and variant updates use
the shared supplied/planner validator: variants must contain four object
entries, matching the renderer's four-variant goal contract. Unknown fields,
malformed variants, wrong targets and sensitive bindings remain rejected.
Changed-slide metadata continues to come from actual accepted differences.

The original source and regression assertions are preserved. Source-pattern
assertions for derived storage keys follow the extracted lease helper. The
refresh fixture uses an immutable owner subject; approval fixtures include
complete visual coverage. A blocked sensitive Judge response deliberately
omits its private version rather than returning its audit payload. The
positive variant fixture uses all four variants and the original malformed
variant Workflow rejection remains covered.

Local gates passed: root `npm run check`, MCP typecheck and 43 tests, and Runner
type generation/typecheck and 53 Node test entries (including its fixture
module). The Runner regressions first exposed failed-export publication and
contract integration gaps; the corrected gates preserve the original tests.
Hosted exact-head CI and real container rendering must be bound separately to
the published candidate. Mocked provider calls and SQLite are not deployed
Cloudflare acceptance.

## Deployment boundary

Both Runner named environments currently point to the same production D1,
R2 bucket and MCP service. Preview polling is disabled, but a preview HTTP job
call or artifact write would still touch those shared resources. The MCP
Worker likewise has no isolated named Preview resources. Do not use that
configuration for synthetic preview writes.

An isolated Preview needs a separately approved MCP service, D1 binding and
R2 bucket or an independently enforced namespace, plus verified matching
Runner/MCP authentication configuration. The Runner's manual deploy workflow
also provisions its Workflow/container bindings and writes environment
secrets. None of these cloud or secret operations were performed for cleanup.
The earlier legacy preview deploy failed during Cloudflare token/header
verification; a dry-run does not resolve that authentication boundary.

Issues #9–14 remain open pending feature adoption and any required isolated
runtime verification. The valid draft/published-version feature request #4
is retained separately. No real provider, sensitive customer payload,
production data write or production deployment was used for this candidate.

Remaining lease design limits are explicit: there is no renewal for legitimate
work beyond the 60-minute lease, and max-attempt exhaustion blocks the project
for any job type, including export. These limits are retained for product
review rather than silently changing the lease contract.
