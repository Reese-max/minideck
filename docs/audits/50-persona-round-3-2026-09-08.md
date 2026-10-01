# 50-Persona Audit — Round 3

Date: 2026-09-08
Protocol: `Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`
Default branch: `main`
Audited default-branch SHA: `d3026875d9ef0f0010137639e789359463139a89`

> Fixed 50-persona model simulation plus current repository/CI evidence. This is not a 50-human study. No deployed Worker/browser/provider behavior is claimed without actual execution evidence.

## Result

Status: **NOT CLEAN — existing publication-boundary finding remains open; no distinct new P0/P1/P2 after dedup.**

Round-2 historical-version isolation #2 is materially present on current source: owner deck reads require the project token, anonymous historical `/p/:id?version=N` reads are blocked, and CI run `34094862999` on the remediation SHA completed successfully with `npm run check`.

The fixed personas were re-run against the post-fix sharing semantics. B03, C04, D02, D05, I02, I05 and J04 reproduce a separate draft/publication boundary: the UI shares one stable `/p/<projectId>` URL, every saved/generated/revised/rollback deck becomes `projects.current_version`, and anonymous `/p/:id` renders that current version. There is no separate published head or unpublish/revocation state.

This fingerprint was already tracked before this audit run as issue #4, `[Competitive Inspiration][FEATURE] 將草稿 current_version 與公開 published_version 分離`. The audit therefore did **not** create a second actionable finding. A temporary duplicate #5 created during issue deduplication was immediately closed with `duplicate`, and #4 was updated with the persona/runtime acceptance linkage.

## Current evidence

- `src/store.js::saveDeckVersion()` increments `current_version` and updates the project to that version on every successful save.
- `src/worker.js::getPlayerResponse()` resolves the latest deck when no version is requested and allows the current version anonymously.
- `public/app.js::share()` copies `${location.origin}/p/${currentProjectId}`; it does not mint a version-scoped or revocable share object.
- README explicitly documents that `/p/:id` always presents `current_version` and that rollback immediately changes what the public link presents.
- Search found no `published_version`, `publish_version`, `unpublish`, share-token lifecycle, or equivalent public-head state on current default source.

## Fixed-persona regression scenario

1. Produce v1 and share `/p/<id>`.
2. Continue editing and save v2 containing sentinel `PRIVATE_DRAFT` without a separate publish action.
3. Existing anonymous recipient reloads the same `/p/<id>`.
4. Current source semantics make v2 the anonymous public result.

This is the same issue fingerprint already covered by #4, so it is not counted as a new portfolio finding.

## Runtime evidence

GitHub Actions CI run `34094862999` is real execution evidence for `npm run check` on audited SHA `d3026875d9ef0f0010137639e789359463139a89`; the job concluded `success`.

No production/preview deployment run was found for that SHA in this audit check, and no browser publish/unpublish flow, D1/R2 migration, concurrent save/publish scenario, or real public-link recipient test was executed here.

## CLEAN gate

`minideck` remains **NOT CLEAN** because open issue #4 still requires an explicit draft/published boundary and runtime acceptance. After that fix lands, rerun the same fixed personas and require two consecutive rounds with no new P0/P1/P2 plus the documented Worker/browser/runtime evidence before marking CLEAN.