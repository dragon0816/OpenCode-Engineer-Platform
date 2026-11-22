# Phase 3B slice 4 assistant management

Base `fc77ebc` on Windows 11 with Node 24.14.1. Branch `phase-3b/slice-4-agent-gui`. All work and commits are local.

## Delivered

- Paired, same-origin agent and workspace-session routes with CSRF on management reads and writes. Owner-scoped session routes also support the existing streaming, download and preview entry points. The legacy project routes continue to expose Main’s two work folders.
- The wizard keeps its draft in the browser. The server rechecks the creation revision and grants before committing the assistant, its workspace and any channel binding. A failed creation removes empty folders made by that request. Channel verification uses Windows user credential references and the existing connector. Confirmed changes retain the channel binding revision and conflict checks from slice 3b.
- The assistant rail, session groups, detail tabs and channel settings are available in Traditional Chinese and English. The old assistant settings and avatar controls moved into Main’s Basics tab, accessible from Settings. Reviews show Telegram BI provenance from the review API. The right panel keeps its existing behavior.

## Scope decisions

- The ledger protects both built-ins. The archive action applies to owner-created specialists. The archived section keeps their settings available for inspection, and their Web conversations remain available as history. An enabled channel or in-flight work blocks archival.
- The session rail lists Web conversations. Telegram conversation history remains in the channel store. A later slice can expose it after the workbench has explicit read grants for channel conversations.
- A selected model pending application uses the active global default for new chats. Configuration preserves the selected model until it is applied or the owner changes the assistant setting. Local and private tools remain paused. The Skills and schedule panels show their planned availability.
- The channel table accepts credential names. Token entry stays in the Windows user credential flow. Verified bot usernames appear while a connection is active. A restored disabled connection can be verified again before binding.

## Test changes

- Added an agent API contract for pairing, same-origin requests, CSRF, create and edit revision conflicts, built-in protection, grant validation, owner-scoped sessions, legacy compatibility and archival. The contract pauses Telegram verification, edits settings in another request, and checks that stale confirmation creates neither a workspace nor an account. Browser coverage adds mouse and keyboard wizard flows, cancellation, copy, archived history, reload persistence, channel conflicts and confirmed reassignments, and review provenance.
- Kept the existing assistant, avatar, discard and focus assertions and moved their locators to Main’s Basics tab. The navigation assertion includes the new channel category. The rail keyboard search visits more controls because the agent rows add focus stops. The separate settings, agent and feature mapping groups verify the relocated controls and new screens.
- The text audit recognizes the same runtime alias in the assistant model picker as in the existing model picker. The locale audit treats interpolated assistant names as user content in accessible row names and allows the specified `Skill 即將開放` label. New select controls are included in the clipping checks.
- Visual review of the first narrow gallery showed that the bot heading broke across letters. The responsive table now presents each account as a labeled row, with its verified assignment above the unverified ones. The narrow test checks that row labels are visible.

## Synthetic gallery

The [gallery directory](../validation/gui/) contains 88 PNGs prefixed `slice4-`. It covers the rail, every wizard step, assistant details, channel bindings, and the review source label in both languages and themes at 1440×900 and 390×844.

- [Rail, Traditional Chinese, wide, light](../validation/gui/slice4-rail-zh-TW-wide-light.png)
- [Wizard confirmation, English, wide, dark](../validation/gui/slice4-wizard-confirm-en-wide-dark.png)
- [Assistant details, Traditional Chinese, narrow, dark](../validation/gui/slice4-detail-zh-TW-narrow-dark.png)
- [Channel bindings, English, narrow, light](../validation/gui/slice4-channels-en-narrow-light.png)
- [Review source, Traditional Chinese, narrow, dark](../validation/gui/slice4-review-zh-TW-narrow-dark.png)

## Sequential verification

The implementation and gallery at `c49b10f` passed the sequence below. Each command used a fresh temporary `OEP_DATA_DIR` and process-local Python from `oep-verify-venv`. The browser and Telegram commands used synthetic services.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 1.0 s. Checked 252 source and configuration files. |
| `npm run typecheck` | Exit 0 in 5.5 s. |
| `npm test` | Exit 0 in 12.3 s. 86 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 18.3 s. The release scan passed. ZIP SHA-256 `a39b5c6c20d7932deb10d4ba9a2608ff8b667be85fe25dc8d14a2555168b2311`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 80.6 s. Assistant workbench and existing Chromium checks passed. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 82.0 s. Assistant workbench and existing Chromium checks passed. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 82.7 s. Assistant workbench and existing Chromium checks passed. |
| `npm run test:e2e:knowledge` | Exit 0 in 27.0 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 4.3 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 36.8 s. 8 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 54.5 s. |
| `npm run test:compliance` | Exit 0 in 0.4 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 39.8 s. 1 passed, 0 failed, 0 skipped. Both ZIPs matched the release SHA-256 above. |
| `npm run test:contract:native:isolation` | Exit 0 in 19.1 s. 5 passed, 0 failed, 0 skipped. |
| `npm run scan` | Exit 0 in 1.4 s. 664 files, 0 hits. |

`npm ci` installed 14 packages and reported zero vulnerabilities. The hook installer initially rejected the inherited hooks snapshot. Setting this worktree’s hook path to the repository’s `.githooks` allowed the installer to activate the hooks and `merge.ff=false` for this worktree.

An earlier ordered run produced three browser failures. Run 1 reached the revised channel table with a locator from the earlier markup and timed out on unbind. Runs 2 and 3 passed the new assistant browser scenarios and timed out on the existing model restart assertion. The session restoration could clear the model-applied notice after it was set. The notice now follows restoration, with the original assertion retained. The final sequence uses the revised locator and notice order.

Native isolation returned 4 of 5 passing tests on the earlier run. Its existing workbook byte comparison failed at the ZIP timestamp field, where the two archives fell on adjacent clock ticks. The assertion stayed in place, and both later runs passed all 5 tests.

## Deferred work

- Telegram conversation history in the workbench awaits an explicit read grant.
- Skill selection and assistant schedules are represented by their planned availability in the wizard and details.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`, plus review and merge.
