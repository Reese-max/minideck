# 50-Persona Audit — Round 4

Date: 2026-09-12
Protocol: `Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`
Default branch: `main`
Audited default-branch SHA before this report: `ed7ffd5f826f4ff6098e546f277b57285674b818`

> Fixed 50-persona model simulation plus current repository/GitHub Actions evidence. This is not a 50-human study. Static evidence is not represented as deployed/runtime validation.

## Result

Status: **NOT CLEAN — existing P2 publication-boundary blocker remains; new P2 #6 for a non-executing default-branch CI gate. CLEAN streak 0/2.**

## Default-branch delta

Compared with the product SHA audited in the previous fixed-persona round (`d3026875d9ef0f0010137639e789359463139a89`), current `main` is only two commits ahead and the diff contains two audit/documentation files:

- `docs/audits/50-persona-round-3-2026-09-08.md`;
- `.github/quality-audits/2026-09-12-1010-product-board-audit.md`.

No product implementation change landed in that interval. Therefore the prior publication-boundary fingerprint remains current rather than being a post-fix rerun.

## Existing P2 — Issue #4 remains reproducible

The same B03/C04/D02/D05/I02/I05/J04 scenarios still fail the trust/publication boundary:

- `projects.current_version` is still the draft/edit head;
- anonymous `/p/:id` still resolves that current head;
- save/generate/revise/rollback can therefore alter what an existing share URL displays;
- there is still no independent `published_version`, explicit publish, or unpublish lifecycle on current product code.

This is already tracked by Issue #4, so no duplicate finding was created. Issue #4 was updated with this round's current-head and runtime evidence.

No deployed disclosure incident is claimed.

## New P2 — Issue #6: default-branch CI records fail before any runner executes

`.github/workflows/ci.yml` declares a normal remote gate for pushes to `main` and PRs to `main` / `production`, with checkout, Node 22 setup, `npm ci`, and `npm run check`.

The latest known successful `main` CI receipt remains run **#27 / 34094862999** on `d3026875d9ef0f0010137639e789359463139a89`.

Two later default-branch pushes now have the same pre-run failure fingerprint:

1. run **#28 / 34221657466** on `3fb825509e4a95d3acb694f26e7d90f5e62d678a`: `failure`, one `check` job, `runner_id=0`, empty runner name, `steps=[]`;
2. run **#29 / 34666960074** on current `ed7ffd5f826f4ff6098e546f277b57285674b818`: `failure`, one `check` job, `runner_id=0`, empty runner name, `steps=[]`.

Because no steps ran, these failures are **not** evidence that checkout, dependency installation, tests, application code, D1/R2 behavior, or the publication path failed. The exact admission/platform cause is not established by the available response and is not guessed.

The actionable regression is that current/recent default-branch pushes lack an actually executing remote verification gate. This is tracked as **P2 #6** because it materially weakens release/regression assurance but is not itself evidence of a current product outage, data loss, or authorization bypass.

Affected fixed personas: C05, D03, H03, H05, I05, J05.

## Fixed-persona rerun summary

- B03/C04/D02/D05/I02/I05/J04: **FAIL / unchanged** publication-state trust scenario because Issue #4 remains on unchanged product code.
- C05/D03/H03/H05/I05/J05: **FAIL** maintenance/release-assurance scenario because two consecutive recent default-branch CI records never execute a runner or the declared verification steps.
- Historical run #27 remains valid evidence that `npm run check` executed successfully on the older product SHA, but it is not substituted for current default-branch execution.
- No Worker/D1/R2 publish/unpublish, browser recipient, concurrent save/publish, accessibility, or deployment acceptance was executed in this round.

## CLEAN gate

`minideck` remains **NOT CLEAN; CLEAN streak 0/2**. Issue #4 remains unresolved and Round 4 adds P2 #6, so the no-new-finding counter resets. Before a CLEAN streak can start:

1. resolve/disposition #4 and #6;
2. obtain real current/recent remote execution receipts for the CI gate;
3. obtain actual Worker/D1/R2/browser evidence for the publication lifecycle after #4 lands;
4. rerun the same fixed 50 personas on the merged default branch;
5. require two consecutive qualifying rounds with no new P0/P1/P2.
