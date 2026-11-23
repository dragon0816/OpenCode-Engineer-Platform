# OEP 0.8 integration review

`integration/0.8` starts at `f0fbc78`, which already includes file references (`d3ca11b`) and the JSON paste fix. The branch merges model sources at `30b8cf4` and remote MCP OAuth at `2faf1f4`. The reference integration and upgrade fixtures are committed separately from the merges. The branch is for local review.

## Conflicts and resolutions

- The model-source merge conflicted in the three documentation logs, the Web chat and adapter startup, external-source classification, the Web store and central ledger, the composer, the release file list, the snapshot allowlist, and five browser or ledger test files. The OAuth merge conflicted in `docs/TASKS.md`. I checked that every nonblank line from the three inputs is present in each merged log, including historical wording that later decisions superseded.
- Adapter startup takes the external worker, MCP credential environment and local picker together. The release includes both reference workers, the external workspace probe, and the helper scripts. The composer retains native reference selection, paste, previews and dictation alongside the grouped source picker and external readiness state.
- The broker retains the native file-read tool and the server-scoped remote MCP tool IDs. The OAuth fixture checks that the built-in file tool remains present while the OAuth tool is granted or withheld by project, agent and workspace. OAuth tokens enter broker requests and stay outside the helper execution environment and OpenCode configuration.
- Backup discovery includes generated static OAuth credential names. The protected OAuth token directory stays out of snapshots. Synthetic reconciliation tests verify that server definitions survive Web migration and protected state remains at its original location.

## SQLite sequence

| Store | From 0.7.0 | Integrated sequence |
| --- | ---: | --- |
| Web central | 8 | 9 creates `agent_model_sources`. 10 creates the reference, member and audit tables. 11 reconciles standalone v10, which already has the reference tables and skipped model sources. |
| Telegram chat | 3 | 3 |
| Knowledge | 3 | 3 |
| Telegram inbox | 2 | 2 |
| Standalone runs | 1 | 1 |

OAuth adds fields to existing MCP definitions and stores protected OAuth state separately. The shared data migration registry derives its expected versions from the store constants. The snapshot allowlist permits the model table to appear empty at v9 or during v11 repair of standalone v10. The model-source and reference DDL is idempotent. Named schema verification checks both sets of objects before SQLite records the final version and on reopen.

The five store constructors from an archived copy of `main` at `c70d957` generated the 0.7.0 schema fixtures with synthetic session, note, run, knowledge and Telegram data. The tests exercise fresh stores, v8, v9, references-only v10 and combined v10. They apply the new DDL twice on the intermediate fixtures, migrate each input twice, and compare the backed-up rows and versions. An incompatible reference audit table forces a failure after both migrations have started. The test checks that SQLite rolls back the new tables, retains v8 and the historical note, and upgrades after the obstruction is removed. [Upgrade fixtures](../../tests/fixtures/upgrade/)

## External reference boundary

Direct external turns and external delegations share the same reference gate. A Web delegation can forward only IDs selected for its current parent message and only the user's own task wording. Reference captures check the session grant, workspace and reference classification, confidential overlaps and the pinned identity. The default accepts public and unclassified data. Strict mode requires public classifications. Directory inputs are bounded to 64 files, 20 MiB per file and 40 MiB across the prompt and all staged inputs. The copy excludes protected paths and reparse points. A confidential descendant blocks a folder selection, and the external worker gets only verified copies under `oep-inputs` and relative display names.

The helper rechecks evidence before release. The fixture changes a child's classification after capture and verifies that no CLI launch or working copy survives. Chromium exercises an owner-confirmed delegation with an uploaded file and a local reference, then a direct external turn with a reference. The native isolation test uses selected and unselected reference IDs through the Gateway file broker.

## Assertion changes

- Web `user_version` expectations of 8, 9 and 10 from the input branches now expect 11 after migration. Historical starting values and checks on the other stores are kept. Both table groups have empty-addition assertions and an exact schema check.
- The Telegram assignment test uses the assistant heading in the grouped channel layout. The dialog must be closed and empty, and keyboard focus restoration, row controls, assignment and responsive layout still have coverage.
- The model-source feature changed the default for per-run confirmation to off. The old `true` default expectations became `false`; the tests exercise explicit confirmation, persistence, strict mode and confidential refusals. The grouped model picker still asserts the exact Gateway options and also checks the external entries and their disabled state.
- The retired external intake dialog and its exact transient queued-state assertion were replaced by the ordinary composer and delegation flow. The test checks the selected inputs, confirmation content, receipt and downloaded result. A direct external turn must stay out of the Gateway request. The Gateway-led delegation intentionally sees the user task in the current turn and rejects legacy `publicInputId` broker arguments for that path.

## Verification

Windows 11 x64 with Node 24.14.1. `npm ci` installed 14 packages. Phase 0 assets and source were copied from the main checkout and matched the pinned hashes. The hook installer accepted the worktree after its inherited hook snapshot path was replaced with the tracked `.githooks` setting for this worktree. Each command had its own fresh temporary `OEP_DATA_DIR` and the process-local `oep-verify-venv` Python.

The initial lint attempt exited 1 on whitespace in the generated Telegram chat dump. The first contract attempt had 114 passes and one failure because SQLite rejected the FTS shadow tables in the generated knowledge dump. The corrected fixture lets SQLite create its shadow tables. A preliminary Chromium run passed in 158.2 s before delegated-reference coverage was added. The first combined Chromium run exited 1 in 122.7 s when an existing reference chip became the last row after a new upload. The retry locates the newest upload row and preserves the exact filename and classification assertions.

The final sequence completed in the requested order. The gate logs are in `.phase0/integration-gates/`.

| Gate | Exit | Time | Observed output |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.2 s | 330 files checked |
| `npm run typecheck` | 0 | 6.2 s | TypeScript completed |
| `npm test` | 0 | 22.9 s | 116 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 20.7 s | Windows x64 ZIP built and scanned |
| `npm run test:e2e:browser` (1) | 0 | 157.4 s | Chromium passed, 0 orphans |
| `npm run test:e2e:browser` (2) | 0 | 163 s | Chromium passed, 0 orphans |
| `npm run test:e2e:browser` (3) | 0 | 161.2 s | Chromium passed, 0 orphans |
| `npm run test:e2e:knowledge` | 0 | 28.2 s | 1 passed, 0 failed, 0 skipped |
| `npm run test:ingest` | 0 | 4.1 s | 16 passed, 0 failed, 0 skipped |
| `npm run test:telegram` | 0 | 38 s | 8 passed, 0 failed, 0 skipped |
| `npm run test:e2e:mcp` | 0 | 102.5 s | Broker, isolated probes, HTTPS, Chromium and synthetic OAuth passed |
| `npm run test:compliance` | 0 | 0.5 s | 2 passed, 0 failed, 0 skipped |
| `npm run test:contract:native:isolation` | 0 | 27.1 s | 5 passed, 0 failed, 0 skipped |
| `npm run test:e2e:delegation` | 0 | 74.6 s | 4 passed, 0 failed, 0 skipped |
| `npm run test:e2e:external-helpers` | 0 | 129.1 s | 10 passed, 0 failed, 0 skipped |
| `npm run test:release:determinism` | 0 | 40.7 s | 1 passed, 0 failed, 0 skipped. Both ZIPs matched the release SHA-256 |
| `npm run scan` | 0 | 1.6 s | 809 files, 0 hits |

The repository build command produced `OEP-0.0.0-windows-x64.zip` with SHA-256 `cc6fe2ed20b636d6515219f4d6c00d6547d58540ae603e96722b28b2c3a6dc23`. Thirteen packaged integration files matched the worktree byte for byte.

## Reviewer follow-up

- Run the dedicated Web, Excel, install, upgrade and backup gates.
- Exercise the native picker foreground, Explorer handoff, live dictation permission, provider account setup and real OAuth sign-in on the reviewer test installation. The automated fixtures use synthetic credentials and temporary data, including temporary integrity labels for the restricted-token test.
