# Phase 3B Slice 6 results

## What the owner can do

- See the state, summary, and exported files of each delegation in its original Main conversation. The owner can open the read-only specialist transcript and execution timeline in the right area, clear unread results, and cancel pending work. A verified result survives a late cancel.
- Send a follow-up in the same Main conversation with earlier delegation summaries and export IDs available to the model. Each ordinary user turn receives up to six recent completed delegations with up to 500 characters per summary. Opening a record or receiving a completion uses the persisted projection.
- Follow a BI submission from its result card to the existing owner review. Approval and publication remain distinct actions. Web displays the publication in the original delegated conversation. Telegram delivers a direct BI publication to the BI bot and topic and a delegated BI publication to the original Main bot and topic.
- Use these controls in Traditional Chinese or English once the reviewed build is deployed. Delegation starts automatically with the normal production workbench.

## Implementation decisions

- The local branch starts at exactly `660d881`. At branch creation, Main's `d8a0bea` tip and the shared slice 4 ancestor `3f1cd4a` had identical trees. Main advanced independently to `cef65b4`, which merges `660d881`.
- Web reads completion and unread state from the central ledger. A paired acknowledgement sets the existing notice's seen time. SSE carries an invalidation hint and reconnect reads the durable state again. Publication comes from the Knowledge store's committed intent and appears once on the originating card.
- Telegram persists the acceptance intent at admission and the completion intent at settlement. Stable effect keys bridge the central ledger and channel outbox. The original channel session and turn corroborate the captured binding. The terminal outbox row follows the persisted parent reply. A provider send with uncertain delivery stays in the existing owner-check flow.
- A general child's transcript is read from its own verified session relationship. The view includes run transitions, metered model and tool activity, verified export routes, and the BI source and review links where present. It uses the workbench's existing keyboard and narrow overlay behavior.

## Verification

The tests used pinned OpenCode 2.3.2, synthetic gateway and Telegram services, separate temporary data directories, and process-local Python. `npm ci` installed 14 packages with zero reported vulnerabilities. The worktree's inherited hook snapshot was rejected. The checked-in `.githooks` path enabled the Phase 0 hooks for this worktree.

### Ordered gates

The implementation and tests through `77afd9e` passed the full ordered sequence.

| Gate | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 269 source and configuration files checked | 1.04 |
| `npm run typecheck` | 0 | TypeScript completed | 5.41 |
| `npm test` | 0 | 98 passed, 0 failed, 0 skipped | 14.39 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 17.50 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium passed, 0 orphans | 98.79 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium passed, 0 orphans | 101.45 |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium passed, 0 orphans | 100.13 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 28.12 |
| `npm run test:ingest` | 0 | 16 passed | 4.09 |
| `npm run test:telegram` | 0 | 8 passed | 24.23 |
| `npm run test:e2e:mcp` | 0 | MCP, isolation probes, HTTPS transport, and Chromium commands passed | 56.10 |
| `npm run test:compliance` | 0 | 2 passed | 0.43 |
| `npm run test:release:determinism` | 0 | 1 passed, identical ZIPs | 38.97 |
| `npm run test:contract:native:isolation` | 0 | 5 passed, 0 orphans | 21.14 |
| `npm run test:e2e:delegation` | 0 | 4 passed, 0 orphans | 63.11 |
| `npm run scan` | 0 | 704 files, 0 hits | 1.50 |

The release build and both determinism builds produced SHA-256 `4413605bfc4947b904fa31df8189cd2e67f7e011c56d14e1ee5323395f85cd77`.

### Synthetic browser and channel scenarios

- Browser coverage follows two specialist jobs from Main's acceptance through independent updates. It checks manifest hashes and previews, persisted unread state, cancellation and continued chat, record tabs and keyboard focus, and the delegated BI review and publication.
- Telegram coverage checks acceptance, parent reply ordering, terminal delivery, and restart deduplication. It sends a synthetic file to the BI bot, verifies its supplement flow and forged-quote rejection, and checks owner-only publication and the publish barrier for search and scoped Ask. The BI bot replies in its original topic.
- The [workbench mapping and gallery](../GUI_LAYOUT.md#版面樣張) include 20 synthetic screenshots. The cards and read-only run cover two locales, two viewports, and two themes, with four additional narrow shots of the running state.
- The Windows release ZIP contains the delegation workbench module, Telegram notice module, and the adapter's delegation registration.

### Development runs

- The first browser run reached two specialist runs. The export fixture used a filename outside the existing controlled file format and its child failed. The fixture now uses a valid filename.
- The second browser run exposed a translated tab title that mixed UI text with an untranslated specialist name. The name now appears as user content in the tab.
- The third browser run reached the narrow audit. The default model's English option clipped and the screenshot exposed a failed acknowledgement request. The composer now stacks the model label at narrow widths and the paired acknowledgement uses the normal session request shape.
- The first Telegram run delivered acceptance and completion in order. Its parent reply assertion found a leading newline from an empty tool-only message. The channel reply now joins assistant messages that contain text. The focused rerun passed.
- The first ordered browser attempts failed at the run mapping in 68.89 s, 69.84 s, and 69.60 s. They exposed the pinned OpenCode pagination contract. The first request selects order and later requests supply the returned cursor. Combining order and cursor made the transcript read fail. The selector and tool activity assertions remain in place.
- A browser rerun reached the cancellation dialog but the DevTools click and dialog handling left the test command pending. Following the existing browser fixture pattern, the test now supplies both responses to `window.confirm` and checks the exact prompt and the persisted outcome of each decision.
- The next browser rerun found a BI candidate created by the fallback intake with its delegation provenance missing. The work item could not verify the candidate as its receipt. Fallback completion now carries the BI source's verified delegation key and run ID into the same transaction as the review and ingest effect.
- After the successful capture run, two browser repetitions failed in 93.40 s and 94.78 s. Both persisted OpenCode traces recorded `ECONNRESET` from the loopback MCP call before the BI turn had a delegation receipt. The broker now closes each stateless tool connection. The browser check also reports a missing or failed persisted receipt directly.
- No existing assertions were deleted or loosened.

## Remaining

- Session-bound BI status and supplement commands for a direct Web conversation remain follow-up work. This slice exercises the domain commands through the BI Telegram conversation and keeps that history out of Main.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`. The tests used neither the installed OEP nor its data directory. The branch remains local for review and merge.
