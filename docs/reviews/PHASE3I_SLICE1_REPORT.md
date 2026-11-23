# Phase 3I Slice 1 classification, source snapshots, and delegation intake

Local branch `phase-3i/slice-1-classification` starts at main `7615675`. Its first commit merges `ci/fix-runner-failures` at `c6efefb`.

## Owner workflow

- In Files, a newly uploaded attachment shows its effective label. The workspace label is available under Projects & Folders and in assistant details. Knowledge shows the label for the active publication and provides a separate action for a selected citation. **Mark public** requires the owner to acknowledge the scope and current version. Files selected from a registered read-only workspace folder are checked individually.
- Settings → External Helpers has independent enable and per-run confirmation switches. Both helpers start disabled. Confirmation defaults on. Enabling requires acknowledging the data-sending warning. Claude Code also requires the persisted owner terms flag. Each setting change increments the provider revision and invalidates snapshots bound to the prior revision.
- A Main Web session can prepare fixed task text and select source files. The paired owner API stores the selected bytes, their SHA-256 hashes, and the server-resolved provenance. The Main model receives a delegation instruction with the opaque snapshot ID. It uses the existing ticketed tool to return a receipt in that conversation.
- The confirmation dialog shows the provider, exact task text, selected inputs, and sizes. The owner approval binds the provider, parent run, snapshot digest, settings revision, and single-use challenge. Before approval the reserved work cannot be claimed. Confirmation records the decision on the card and releases the queue hold in the same transaction.

## Gate and persistence

- Admission and confirmation revalidate source permissions and content. The synthetic worker performs the same check before invocation. A source workspace, a target workspace, and every selected input must be public. Derived text pins the exact versions of its parents and inherits the strictest label recursively. Published citations require a live parent grant, model consent, the active revision, a verified excerpt, and original source metadata in the verified manifest. Copying data through the internal project reader or an internal handoff does not register a new owner-upload origin.
- The paired owner API can classify supported records as public, unclassified, or confidential. Confidential versions stay blocked until the company makes an independently reviewed public version available. Legacy uploads and generated files without verifiable lineage remain ineligible. A registered workspace file can be reviewed again when its bytes change.
- The external path reserves the existing delegation budget and uses the same request-key and content deduplication, cancellation, expiry, and card refresh. The released adapter has no external executor. The test-injected worker consumes only the validated snapshot. There is no vendor subprocess or vendor account use.
- Web SQLite v7 adds four named STRICT tables for provider settings, sources, snapshots, and confirmations. The migration adds empty tables and leaves the existing ledger and data classifications intact. Upgrade and rollback reconciliation compare the named tables and verify their SQL definitions, index, and foreign keys. The historical v6 fixture keeps an internal receipt and rejects removal of the snapshot index.

## Test coverage and assertion changes

- Synthetic contracts exercise unknown sources, confidential roots, missing labels, altered workspace bytes and attachment hashes, changed derived parents, revoked knowledge access, exact selected snapshot bytes, confirmation binding, replay and expiry, queue release, and settings persistence. The fake worker observes zero dispatches from blocked or unconfirmed requests.
- Chromium exercises keyboard activation, warning cancellation and focus restoration, marking a file public, creating an intake, and entering owner confirmation in both zh-TW and English at 1440 px and 390 px. The synthetic gateway checks that the external task and attachment text stay outside the parent model request.
- The paired API also accepts reviewed derived text with an explicit list of source IDs. The browser composer prepares owner-authored task text.
- The delegation schema assertions now check both closed argument shapes. The internal shape still requires `task` and excludes `publicInputId`. The external shape requires `publicInputId` and excludes `task` and `attachmentIds`. Migration version assertions now expect v7 in the Web store and preserve the existing data, restart, and index assertions. Browser navigation coverage includes the new settings category and preserves the existing keyboard transition from Projects & Folders to Integrations.

## Verification

Windows 11 x64 and Node 24.14.1. `npm ci` installed 14 packages with zero reported vulnerabilities. The worktree used the Phase 0 assets and source copied from main. The Phase 0 installer enabled the checked-in hooks and `merge.ff=false` for this worktree. Each gate received a fresh temporary `OEP_DATA_DIR` and process-local Python from `oep-verify-venv\Scripts`.

The implementation at `8dcc662` passed the ordered sequence below.

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 279 source and configuration files checked | 1.08 |
| `npm run typecheck` | 0 | TypeScript completed | 5.01 |
| `npm test` | 0 | 102 passed, 0 failed, 0 skipped | 15.94 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 16.16 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium passed, 0 orphans | 120.67 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium passed, 0 orphans | 122.52 |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium passed, 0 orphans | 114.78 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 27.08 |
| `npm run test:ingest` | 0 | 16 passed | 4.04 |
| `npm run test:telegram` | 0 | 8 passed | 24.26 |
| `npm run test:e2e:mcp` | 0 | Broker scope, isolated probes, HTTPS transport, and Chromium passed | 56.25 |
| `npm run test:compliance` | 0 | 2 passed | 0.43 |
| `npm run test:release:determinism` | 0 | 1 passed, identical ZIPs | 33.06 |
| `npm run test:contract:native:isolation` | 0 | 5 passed | 21.09 |
| `npm run test:e2e:delegation` | 0 | 4 passed | 62.76 |
| `npm run scan` | 0 | 718 files, 0 hits | 1.48 |

The release build and both determinism builds produced SHA-256 `d9f3c2909a002f71c19f4cd373171fdc3021e0491866519631bfa080ee31bf2a`. Six ZIP entries were compared byte for byte with the worktree files, covering the migration, source gate, delegation intake, browser module, and both catalogs.

Lint and typecheck passed again with the reviewer’s updated upgrade assertions.

### Development runs

- The first focused contract run passed 9 of 11 tests. The new fixtures initially used the return value of a void session store method and a synthetic request hash outside the schema format. The corrected fixtures passed 11 of 11.
- The first ordered attempt passed lint and failed TypeScript because the browser settings-picker fixture return type was too narrow. The second reached the contract suite and passed 100 of 102. The retry corrected the remaining v7 expectation and made the new message keys statically visible to the catalog audit.
- An early full browser run failed after 29.63 s because the new settings category interrupted the existing Projects & Folders to Integrations keyboard transition. External Helpers now follows External Tools. A focused browser attempt exposed a race waiting for the native warning dialog to close and restore focus. Waiting for the dialog element to be removed and its prior checkbox state restored passed all four combinations with zero orphan processes.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`. The installed OEP and its data directory were outside the worktree and test setup. The branch remains local for review and merge.

## Remaining Phase 3I work

- Slice 2 covers the dedicated Windows identities, Job and network isolation, pinned native binaries, login and version probes, and provider-specific release verification.
- Slice 3 covers verified result diffs and downloads. The accepted first-version workflow has the owner apply changes manually.
