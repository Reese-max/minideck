# 50-Persona Audit — Round 1

Date: 2026-09-06
Protocol: `Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`

> Fixed 50-persona model simulation plus repository and CI evidence review; not 50 human participants.

## Round 1 result

Status: **STATIC PASS + CURRENT-MAIN CI PASS / RUNTIME-PENDING — NOT CLEAN**

No new reproducible P0/P1/P2 finding was confirmed from the static evidence reviewed this round.

## Evidence reviewed

- README documents project-token authorization for state/write operations, Turnstile on project creation, quotas, intentional public deck/image resources and a fail-closed deletion path that keeps D1 metadata if R2 cleanup fails.
- Current `main` is SHA `679c7e99f1053e9417ae4fd6e6f8640409992e99`.
- GitHub Actions CI run `32918317172` ran on that exact SHA and concluded `success`.

## Fixed-persona scenarios still requiring runtime evidence

- I01/J02: repeated/concurrent project creation, generation and delete operations under quota pressure.
- I04/I05: MiniMax/Turnstile/R2/D1 timeout or partial-failure behavior and retry idempotency.
- J04/D03: token guessing/replay and cross-project write/delete attempts.
- G01/G04: keyboard-only and 200% zoom on the presentation editor/viewer.
- H05: clean deployment with required bindings/secrets and rollback.

## CLEAN gate

1. Obtain non-production Worker runtime evidence for authorization, quota, partial failure and deletion/retry paths.
2. Validate browser accessibility/editor flows.
3. Re-run the fixed personas on current/recent code.
4. Require two consecutive rounds without new P0/P1/P2 before CLEAN.

## Runtime status

Current-main CI is real execution evidence. Provider, Cloudflare storage and browser paths were not executed in this Round 1.

---

# Round 2 continuation — 2026-09-06

> Repository/static review only. No new browser, provider, Cloudflare runtime, or live exploitation claim is made here.

## Result

Status: **NOT CLEAN — NEW P2**

### P2 — a normal share capability also exposes historical deck versions

The product UI copies `/p/<projectId>` as the Share URL and the player resolves the latest deck. However `GET /api/projects/<projectId>/deck?version=N` is anonymous and does not call `authorizeProject()`. The README explicitly documents raw version retrieval as a public read resource.

Because the share recipient necessarily learns the same high-entropy project ID, they can derive `?version=1`, `?version=2`, and so on. This is not an ID-guessing finding; it is a capability-scope finding: a user who removes sensitive, incorrect, or draft material in a later version can still disclose that earlier material when sharing the project ID.

Tracking: `#2 — [P2][50-persona audit] Do not expose historical deck versions through a shared project ID`.

Affected fixed personas: B03, C04, D05, I02, J04.

## Regression requirement

Create v1 containing a sentinel such as `DRAFT_SECRET`, create v2 without it, copy the normal `/p/<id>` Share URL, then act as an unrelated anonymous recipient. The recipient may view the intended shared deck but must not be able to recover `DRAFT_SECRET` through a historical version URL unless historical sharing was explicitly enabled.

## Updated CLEAN gate

In addition to the Round 1 runtime requirements, issue #2 must be resolved or explicitly justified `not_planned`; after the fix, rerun the same fixed personas and require two consecutive rounds with no new P0/P1/P2 before CLEAN.