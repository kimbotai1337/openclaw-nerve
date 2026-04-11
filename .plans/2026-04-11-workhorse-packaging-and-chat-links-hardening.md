# gambit-openclaw-nerve — workhorse packaging + chat links hardening

**Date:** 2026-04-11  
**Status:** In Progress  
**Agent:** Chip 🐱‍💻

---

## Goal

Audit the current local `workhorse` delta, separate canonical source-branch work from local integration-only rollups, package the upstream-worthy fixes into Issues/PRs on the correct branches, and then evaluate product hardening options for missing `CHAT_PATH_LINKS.json` behavior.

---

## Overview

Yesterday’s lane ended with local `workhorse` ahead of `origin/workhorse` by five commits, all confirmed working in dogfood. The important repo-hygiene constraint Derrick reinforced is still the governing rule: product fixes should not live only on `workhorse`. Each upstream-worthy fix needs a clean home on the branch that actually owns it, with `workhorse` acting only as the downstream dogfood/integration branch.

The immediate work is therefore packaging and provenance, not more blind coding. First we need a precise rundown of what the five local `workhorse` commits are doing, how they cluster into distinct product lanes, and which clean source branches already exist for them. That audit must also verify whether any of those owning branches already have upstream Issues/PRs in flight so we modify the existing owning branch instead of accidentally creating duplicate lanes. Every candidate source branch we touch, plus the new hardening lane if we create it, must be confirmed to descend directly from `upstream/master` rather than from `workhorse`.

After that packaging work is stable, we can discuss hardening. The missing `CHAT_PATH_LINKS.json` file exposed a weak bootstrap/default path: the feature silently degraded into confusing behavior instead of clearly regenerating or surfacing the missing config. The hardening conversation should compare install-time OS-aware seeding, in-product editability/restart flow, and a guaranteed default-file regeneration path when the file is absent.

---

## Tasks

### Task 1: Audit local `workhorse` commit stack and classify ownership

**Bead ID:** `nerve-wlgl`  
**SubAgent:** `primary`  
**Prompt:** Inspect local `workhorse` versus `origin/workhorse`, summarize each of the five local commits in plain engineering language, map each commit to its canonical source branch (if one already exists), and recommend whether the current local stack should be treated as one branch/lane or split into multiple upstream lanes. Explicitly call out which commits are renderer/linkification work versus upload-config/Add-to-chat work versus any hardening/bootstrap follow-up that is not yet productized. Also check GitHub for existing upstream Issues/PRs tied to those owning branches so we reuse the current lane instead of duplicating it, and verify each owning branch descends from `upstream/master` rather than `workhorse`.

**Folders Created/Deleted/Modified:**
- `.plans/`
- repo metadata only during analysis

**Files Created/Deleted/Modified:**
- `.plans/2026-04-11-workhorse-packaging-and-chat-links-hardening.md`

**Status:** ✅ Complete

**Results:** Local `workhorse` is ahead of `origin/workhorse` by 5 commits and the stack cleanly splits into two existing source branches, not one monolith. Four commits belong to `bugfix/workspace-inline-reference-slice` and one commit belongs to `fix/upload-config-capability`.

Commit rundown / ownership:
- `4e3c8fb` — linkifies embedded `/workspace/...` path slices in markdown/chat and adds focused renderer coverage. This is a cherry-pick of `36cca92` from `bugfix/workspace-inline-reference-slice`.
- `2b064f0` — narrows inline path token typing so the matcher stops overreaching. Matches `d3d3a64` on `bugfix/workspace-inline-reference-slice`.
- `719db38` — fixes wrapped/punctuation-adjacent workspace inline links in the renderer. Matches `a04876e` on `bugfix/workspace-inline-reference-slice`.
- `5435706` — tightens workspace-rooted matching plus resolve-path guardrails/tests so only intended workspace-style paths become actionable. This is a cherry-pick of `6cf2616` from `bugfix/workspace-inline-reference-slice`.
- `40e9e14` — restores the server upload-config capability endpoint with helper + route + tests. Matches clean branch `fix/upload-config-capability` commit `5b2b092`.

Git ancestry verification:
- `bugfix/workspace-inline-reference-slice` and `fix/upload-config-capability` both merge-base with `upstream/master` at `a5f7973`, and both have the same merge-base against `workhorse`.
- `git merge-base --is-ancestor upstream/master <branch>` succeeds for both branches.
- `git merge-base --is-ancestor workhorse <branch>` fails for both branches, so neither clean branch descends from current `workhorse`.

GitHub state (upstream `daggerhashimoto/openclaw-nerve`):
- No existing upstream PRs match branch names `bugfix/workspace-inline-reference-slice` or `fix/upload-config-capability`.
- No upstream issue/PR currently covers the upload-config restoration lane.
- The broader chat-path-links feature already exists upstream as issue `#237` and PRs `#238` (closed, wrong stack) / `#239` (merged). The current four workspace commits are follow-up fixes/hardening on that already-landed lane, not a duplicate of the original feature PR.
- Existing open attachment/add-to-chat upstream lanes are `#232` / PR `#233` (workspace file-tree Add to chat) and `#234` / PR `#235` (directory context insertion). The local upload-config fix appears adjacent infrastructure for those workflows, not an already-filed upstream lane.
- No upstream issue/PR was found yet for missing-file/default-regeneration hardening around `CHAT_PATH_LINKS.json`.

Packaging recommendation:
- Split the local 5-commit delta into multiple upstream lanes.
- Lane 1: workspace linkification follow-up fixes = the 4 commits owned by `bugfix/workspace-inline-reference-slice`.
- Lane 2: upload-config / Add-to-chat capability restoration = the 1 commit owned by `fix/upload-config-capability`.
- Lane 3: separate future hardening/bootstrap lane for `CHAT_PATH_LINKS.json` missing-file/default regeneration; keep it out of the two validated bugfix lanes because no code for that policy exists in the current 5-commit stack.

Decision note: `workhorse` is acting as a downstream integration branch here. The clean source of truth already exists for the first two lanes, so the next step should update/reuse those owning branches rather than creating fresh duplicate branches from `workhorse`.

---

### Task 2: Reconcile branch provenance and decide packaging strategy

**Bead ID:** `nerve-bs0u`  
**SubAgent:** `primary`  
**Prompt:** Using the Task 1 audit, confirm which clean source branches already contain the validated fixes, identify any local-only `workhorse` commits that still lack a proper owning source branch, and propose the exact packaging plan for upstream work: branch names, issue boundaries, PR boundaries, and which items should remain local-only integration commits if any.

**Folders Created/Deleted/Modified:**
- `.plans/`
- git branches / refs as needed for inspection only

**Files Created/Deleted/Modified:**
- `.plans/2026-04-11-workhorse-packaging-and-chat-links-hardening.md`

**Status:** ✅ Complete

**Results:** Packaging decision is now explicit and operational:
- No local-only `workhorse` commit lacks an owning clean branch. All 5 local commits already have proper canonical homes: 4 on `bugfix/workspace-inline-reference-slice`, 1 on `fix/upload-config-capability`.
- Branch/package boundaries:
  - `bugfix/workspace-inline-reference-slice` stays a standalone upstream follow-up lane for post-`#239` chat-path-link rendering fixes. Treat it as a narrow bugfix slice, not as a continuation of the already-closed feature issue `#237`.
  - `fix/upload-config-capability` stays a separate one-commit infrastructure/attachment-capability lane. Do not fold it into the workspace linkification branch or directly into PRs `#233`/`#235`.
  - missing-file/default-regeneration behavior for `CHAT_PATH_LINKS.json` should be a third future lane, opened as its own issue before implementation.
- Issue strategy:
  - Open a new focused issue for the workspace linkification follow-up regressions/edge cases; reference `#237` / merged `#239` as prior art instead of reopening or reusing them.
  - Open a new focused issue for upload-config capability restoration; mention its relationship to the open Add-to-chat stack (`#232`/`#233` and `#234`/`#235`) because it restores supporting server capability, but keep scope independent.
  - Open a separate hardening/bootstrap issue for auto-regenerating/defaulting `CHAT_PATH_LINKS.json` when missing, before any code work starts.
- PR strategy:
  - Push `bugfix/workspace-inline-reference-slice` as-is and open one PR from that branch after creating its focused issue.
  - Push `fix/upload-config-capability` as-is and open one PR from that branch after creating its focused issue.
  - Do not rebase either branch onto `workhorse`; both already descend cleanly from `upstream/master` and are appropriately scoped.
  - Only adjust branch text (commit messages/PR descriptions/issue linkage) if needed during packaging; no product-code replay is required.
- What remains local-only on `workhorse` after packaging:
  - No unique product commit should remain local-only there.
  - `workhorse` may temporarily continue carrying the same cherry-picks as downstream dogfood/integration history until the clean branches are pushed and upstream review lands, but provenance should point to the clean branches, not `workhorse`.

---

### Task 3: Close out Issues + PRs for the approved packaging plan

**Bead ID:** `nerve-gyqp`  
**SubAgent:** `coder`  
**Prompt:** Execute the approved upstream packaging plan: create any missing clean source branch work needed from current validated commits, open or update the corresponding GitHub Issues/PRs, and leave `workhorse` as the downstream integration branch only. Record commit provenance carefully so the final summary can show canonical branch commit(s), `workhorse` cherry-pick commit(s), and linked Issue/PR numbers.

**Folders Created/Deleted/Modified:**
- product source files only if packaging gaps require a clean-branch replay
- `.plans/`

**Files Created/Deleted/Modified:**
- `.plans/2026-04-11-workhorse-packaging-and-chat-links-hardening.md`
- any touched source/test files required for canonical branch packaging

**Status:** ✅ Complete

**Results:** Both approved clean branches were verified, pushed, and packaged upstream without touching product code.

Verification / provenance checks:
- `bugfix/workspace-inline-reference-slice` still exists locally at `6cf2616` and `git merge-base --is-ancestor upstream/master bugfix/workspace-inline-reference-slice` succeeds.
- `fix/upload-config-capability` still exists locally at `5b2b092` and `git merge-base --is-ancestor upstream/master fix/upload-config-capability` succeeds.
- Neither branch had an existing upstream PR open from the Gambit fork before packaging.
- Both branches were pushed to `origin` and now track:
  - `origin/bugfix/workspace-inline-reference-slice`
  - `origin/fix/upload-config-capability`

Workspace linkification follow-up lane:
- Issue `#262` — <https://github.com/daggerhashimoto/openclaw-nerve/issues/262>
- PR `#264` — <https://github.com/daggerhashimoto/openclaw-nerve/pull/264>
- Branch: `bugfix/workspace-inline-reference-slice`
- Canonical clean-branch commits:
  - `36cca92` — `fix(markdown): linkify embedded workspace path slices`
  - `d3d3a64` — `fix(markdown): narrow inline path match typing`
  - `a04876e` — `Fix wrapped workspace inline path links`
  - `6cf2616` — `Tighten workspace-rooted inline path matching`
- Validated downstream via local `workhorse` cherry-picks:
  - `4e3c8fb` <- `36cca92`
  - `2b064f0` <- `d3d3a64`
  - `719db38` <- `a04876e`
  - `5435706` <- `6cf2616`
- Packaging note: the new issue explicitly references prior art `#237` / merged PR `#239` and scopes this lane as a post-merge bugfix follow-up rather than reopening the original feature request.
- Review follow-up update (2026-04-11): addressed PR `#264` review feedback on the owning branch — inline workspace candidates now percent-decode before dispatch, inline code stops linkifying when already inside a markdown link to avoid nested anchors, and overmatch regressions now assert zero rendered links. Focused markdown tests and targeted eslint passed after the fix.

Upload-config capability restoration lane:
- Issue `#263` — <https://github.com/daggerhashimoto/openclaw-nerve/issues/263>
- PR `#265` — <https://github.com/daggerhashimoto/openclaw-nerve/pull/265>
- Branch: `fix/upload-config-capability`
- Canonical clean-branch commit:
  - `5b2b092` — `fix(server): restore upload config endpoint`
- Validated downstream via local `workhorse` cherry-pick:
  - `40e9e14` <- `5b2b092`
- Packaging note: the new issue references related Add-to-chat lineage `#232`/`#233` and `#234`/`#235`, while keeping the lane narrowly scoped to the missing `/api/upload-config` capability route.

Hardening lane decision:
- No `CHAT_PATH_LINKS.json` hardening/bootstrap issue was created in this packaging pass.
- Recommendation remains to evaluate that as a separate later lane, exactly as planned, instead of muddying the two clean bugfix PRs above.

---

### Task 4: Evaluate chat-links hardening strategies

**Bead ID:** `Pending`  
**SubAgent:** `research`  
**Prompt:** Review the current `feature/chat-path-links` lineage, the live missing-file failure mode for `CHAT_PATH_LINKS.json`, and Derrick’s three hardening options. Produce an engineering recommendation that compares: (1) OS-aware install-time seeding of home-path prefixes, (2) Nerve settings UI access/edit/restart flow, and (3) doing both. Include a minimum-safe hardening requirement: if the chat links file is missing, generate the default file automatically and avoid silent broken states.

**Folders Created/Deleted/Modified:**
- `.plans/`
- source files only if code inspection is needed

**Files Created/Deleted/Modified:**
- `.plans/2026-04-11-workhorse-packaging-and-chat-links-hardening.md`

**Status:** ⏳ Pending

**Results:** Pending.

---

## Final Results

**Status:** ⏳ Pending

**What We Built:** Pending.

**Commits:**
- Pending

**Lessons Learned:** Pending.

---

*Created on 2026-04-11*