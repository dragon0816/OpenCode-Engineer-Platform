# Phase 3B slice 4 assistant management

Base `fc77ebc` on Windows 11 with Node 24.14.1. Branch `phase-3b/slice-4-agent-gui`. All work and commits are local.

## Delivered

- Paired, same-origin agent and workspace-session routes with CSRF on management reads and writes. Owner-scoped session routes also support the existing streaming, download and preview entry points. The legacy project routes continue to expose Main’s two work folders.
- The wizard keeps its draft in the browser. The server rechecks the creation revision and grants before committing the assistant, its workspace and any channel binding. A failed creation removes empty folders made by that request. Channel verification uses Windows user credential references and the existing connector. Confirmed changes retain the channel binding revision and conflict checks from slice 3b.
- The assistant rail, session groups, detail tabs and channel settings are available in Traditional Chinese and English. The old assistant settings and avatar controls moved into Main’s Basics tab, accessible from Settings. Reviews show Telegram BI provenance from the review API. The right panel keeps its existing behavior.

## Scope decisions

- The ledger protects both built-ins. The archive action applies to owner-created specialists. Archived specialists leave the active rail, and their Web conversations remain available as history. An enabled channel or in-flight work blocks archival.
- The session rail lists Web conversations. Telegram conversation history remains in the channel store. A later slice can expose it after the workbench has explicit read grants for channel conversations.
- A selected model pending application uses the active global default for new chats. Configuration preserves the selected model until it is applied or the owner changes the assistant setting. Local and private tools remain paused. The Skills and schedule panels show their planned availability.
- The channel table accepts credential names. Token entry stays in the Windows user credential flow. Verified bot usernames appear while a connection is active. A restored disabled connection can be verified again before binding.

## Test changes

- Added an agent API contract for pairing, same-origin requests, CSRF, create and edit revision conflicts, built-in protection, grant validation, owner-scoped sessions, legacy compatibility and archival. Browser coverage adds mouse and keyboard wizard flows, cancellation, copy, archived history, reload persistence, channel conflicts and confirmed reassignments, and review provenance.
- Kept the existing assistant, avatar, discard and focus assertions and moved their locators to Main’s Basics tab. The navigation assertion includes the new channel category. The rail keyboard search visits more controls because the agent rows add focus stops. The separate settings, agent and feature mapping groups verify the relocated controls and new screens.
- The text audit recognizes the same runtime alias in the assistant model picker as in the existing model picker. The locale audit treats interpolated assistant names as user content in accessible row names and allows the specified `Skill 即將開放` label. New select controls are included in the clipping checks.

## Sequential verification

Pending.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`, plus review and merge.
