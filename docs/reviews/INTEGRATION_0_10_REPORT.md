# OEP 0.10 integration review

`integration/0.10` starts at `main` commit `4c64e48`, the 0.9.0 source and follow-up documentation. It merges the five reviewed tips in order. The branch is for local review.

| Order | Input | Merge |
| ---: | --- | --- |
| 1 | Windows OCR and PDFium `e2a0e46` | `77b15df` |
| 2 | Subscription sign-in `81dafc1` | `3a95896` |
| 3 | Gateway aliases and owner notes `9c79a65` | `9fc3077` |
| 4 | Capabilities and trusted stdio MCP `b59011e` | `f490ca3` |
| 5 | BI Knowledge parity `39ce99f` | `23768b2` |

## Conflicts and cross-feature checks

- The OCR merge overlapped the subscription decision in `DECISIONS.md`. The Capabilities and BI parity merges both added sections at the end of `TASKS.md`. Every nonblank line in `DECISIONS`, `TASKS`, `PHASE3_REQUIREMENTS` and `GUI_LAYOUT` was checked against `main` and all five tips. The previous Settings layout and mapping rows remain verbatim in the GUI history. The active mapping places custom MCP controls in Capabilities, keeps the link and built-in Knowledge status in Settings, and verifies the current table IDs in Chromium.
- Capabilities and model notes both claimed Web v13. The model-notes migration keeps v13 and Capabilities uses v14. Named verification checks both table groups before a Web migration commits, on reopening and during backup reconciliation. Knowledge v4 adds the published-import table check in the write and read paths and reconciliation. The two new Web allowlists and the Knowledge allowlist accept only the expected empty additions across their version boundaries. Historical BI ownership checks still apply at Knowledge v4.
- Adapter startup installs both the subscription-login exchange and the Capabilities handlers. The sign-in polling route retains its execution-recheck exemption, and Capabilities Knowledge changes trigger rechecks. The existing model pickers retain Gateway annotations, external-provider grouping and sign-in availability in both locales. BI Ingest and Testing show the same alias notes on their Gateway choices. Their model requests use the existing Gateway seat.
- BI Knowledge 1.2.0 resolves the extraction and worker conflicts by passing a recognition callback into the Convert worker and keeping separate bounds for OCR RPC frames and working-draft results. The Convert panel saves the reader, OCR language and recognition mode together. Paused runs persist the projection and its evidence metadata before Ingest resumes. Text-layer documents retain stable receipts. Raster documents use a receipt derived from recognized text and OCR provenance, and reruns can apply a different recognition policy. The legacy document entry uses local OCR. Scheduled Telegram runs use the target's saved Convert settings and the approved HTTPS origins.
- The broker registers BI card queries alongside Knowledge Ask, controlled file reads and writes, delegation, and custom MCP tools. The assistant scope carries both installed Skills and published BI bindings. The Capabilities tests import a published package and a BI repository export, bind each to an assistant, and exercise the BI query procedure and tool. Removing the imported package revokes BI query availability and existing evidence access. The prior tests still exercise controlled local references, scoped remote and OAuth MCPs, and trusted stdio grants and revocation.
- Standard and bundled builds retain the pinned `openpyxl` 3.1.5, `pypdf` 6.21.4 and `pypdfium2` 5.15.2 inputs. The determinism test checks the required worker, script, migration, UI and requirements paths against the worktree, checks BI payload bytes against the plugin package, verifies the Hermes skill and PDFium notices, and renders a page with the bundled Python. The BI artifact contains the staged readers, rule inference and working-draft replay.

## SQLite sequence

| Store | 0.9.0 | 0.10 sequence |
| --- | ---: | --- |
| Web central | 12 | 13 adds `web_model_notes`. 14 adds `installed_skills`, `capability_defaults`, `imported_workflows` and `workspace_mcp_overrides`. |
| Knowledge | 3 | 4 adds `published_imports`. |
| Telegram chat | 3 | 3 |
| Telegram inbox | 2 | 2 |
| Standalone runs | 1 | 1 |

The two 0.9.0 SQL fixtures come from Web and Knowledge store constructors in a clean archive of `4c64e48`. They contain a synthetic session annotation and a synthetic BI publication. The fixture export uses SQLite's virtual-table definition and logical rows so SQLite can rebuild the FTS shadow tables. The restored fixtures passed integrity, foreign-key and logical-row equality checks. The tests exercise fresh stores, those fixtures, and Web v13 with a stored alias and note. They migrate each fixture twice, reconcile row digests against its snapshot, and check that the annotation, publication and intermediate alias note survive. The tests retain the earlier v8–v12 migration cases, including both historical v10 shapes.

One probe obstructs the final v14 table after Web has begun both migrations. Another fails Knowledge ownership verification after the v4 DDL. Both assert that the new tables and version changes roll back, historical rows remain, and an unobstructed retry succeeds. Subscription sign-in uses the existing external-helper schema. OCR and BI parity keep Convert checkpoints, working copies and stage settings in BI plugin storage. Scheduled intake uses the existing scheduler tables and BI source ownership records.

## Assertion changes

- Final Web version assertions now require 14 and final Knowledge assertions require 4. The historical starting versions and rollback assertions remain. One stale Web checkpoint still expected v13 during the first contract run. That run had 127 passes and one failure, and the checkpoint now asserts v14 with the same historical row assertions.
- The GUI mapping audit now counts IDs in the three active tables. It still requires one unique ID for every current row and checks each of those rows. The copied Settings rows describe the previous layout and are kept as historical text.
- The Capabilities branch replaced the assistant wizard's upcoming-Skill message with its current instruction to enable Skills after creating the assistant. The MCP restart visibility assertion follows the control to Capabilities. The collapsed-navigation keyboard assertions add the Capabilities entry and retain the previous controls. [Capabilities review](UX_CAPABILITIES_PAGE_REPORT.md)
- Subscription sign-in replaced the provider-auth dropdown and its keyboard selection with the focused subscription action and a keyboard-operable Advanced disclosure. The advanced key field still has password masking coverage. The Gateway discovery assertion now requires the original models request plus the two model-info lookup paths with the same request policy. Model checkbox assertions target checkboxes because the list also contains note fields. The metadata assertion still checks the original credential and gateway markers and covers provider metadata and stored notes. [Subscription review](PHASE3I_SUBSCRIPTION_LOGIN_REPORT.md) · [Gateway alias review](UX_MODEL_ALIAS_NOTES_REPORT.md)
- The OCR browser test sets model recognition through **Save stage settings** in Convert and resumes Ingest and Testing after inspecting the completed recognition. The original local, vision, review and citation assertions still apply. Capabilities tests require Knowledge Ask alongside BI Query on a current binding. After removal they verify BI query withdrawal and Knowledge Ask abstention because the generic Ask tool can still be shown for a saved binding.
- The existing restricted-token external-helper test calls `icacls /setintegritylevel`. The requested helper gate uses a process-local name filter for its two ACL-free cases. The fixture and its assertions are available for reviewer execution. The subscription contract and Chromium flow use synthetic provider processes.

## Verification

Windows x64, Node 24.14.1, npm 11.11.0 and the process-local verification Python 3.12.7. `npm ci` installed 17 packages. Phase 0 assets and source came from the main checkout. The hook installer ran after configuring `.githooks` for this worktree. The release cache inputs were verified against their pins. Each gate used a fresh temporary `OEP_DATA_DIR`. The normal plugin sandbox uses its own disposable AppContainer and staging paths. The installed OEP, its program and data paths, Windows accounts and system ACLs were outside the test scope.

The tool session disconnected during the first launch of Chromium run 3 and recorded no exit status. No test process matched that launch's isolated data root after reconnect. The restarted run used a fresh root, passed and reported zero orphans.

The first combined MCP gate exited 1 after 60.63 s. The Capabilities card had a working Test Connection control, and its new trust text omitted the existing message that a paused stdio connection can still be tested. Both locales now explain that option. The browser assertion and its trust and isolation checks remain in place.

The next MCP gate exited 1 after 93.53 s. The OAuth callback succeeded, but the browser waited for the sign-out button and timed out. The poller still watched the old Settings section, which is hidden while the MCP list is visible in Capabilities. It now follows the list's visibility, and the bilingual browser fixture reopens Settings before using its MCP link in each locale.

The first Capabilities run exited 1 after 76.59 s with one pass and one failure. The new imported-BI test looked for the query procedure in OpenCode's system message. OEP appends the procedure to the admitted user message. The assertion now checks that message and still verifies the binding ID, exact broker tool, returned evidence and removal behavior. The focused retry passed both tests in 50.17 s.

The final ordered pass ran on implementation commit `2abb459`. Logs and prior attempts are in `.phase0/integration-0.10-gates/` in the integration worktree.

| Gate | Exit | Seconds | Observed result |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.60 | Checked 416 source and configuration files |
| `npm run typecheck` | 0 | 6.23 | TypeScript completed |
| `npm test` | 0 | 41.54 | 128 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 19.74 | Standard Windows x64 ZIP built and scanned |
| `npm run build:plugin:bi` | 0 | 1.53 | BI Knowledge 1.2.0 packaged |
| `npm run test:e2e:browser` | 0 | 201.26 | Chromium run 1 passed with zero orphans |
| `npm run test:e2e:browser` | 0 | 199.27 | Chromium run 2 passed with zero orphans |
| `npm run test:e2e:browser` | 0 | 201.90 | Chromium run 3 passed with zero orphans |
| `npm run test:e2e:knowledge` | 0 | 42.36 | 1 passed, 0 failed, 0 skipped |
| `npm run test:ingest` | 0 | 4.39 | 16 passed, 0 failed, 0 skipped |
| `npm run test:telegram` | 0 | 40.92 | 8 passed, 0 failed, 0 skipped |
| `npm run test:e2e:mcp` | 0 | 124.46 | Broker permissions, isolated probes, HTTPS, Chromium and synthetic OAuth passed |
| `npm run test:compliance` | 0 | 0.51 | 2 passed, 0 failed, 0 skipped |
| `npm run test:contract:native:isolation` | 0 | 34.33 | 5 passed, 0 failed, 0 skipped |
| `npm run test:e2e:delegation` | 0 | 89.43 | 4 passed, 0 failed, 0 skipped |
| `npm run test:e2e:external-helpers` | 0 | 6.54 | 2 passed, ACL-free name filter |
| `npm run test:bi-extraction` | 0 | 15.95 | 1 passed, 0 failed, 0 skipped |
| `npm run test:bi-ocr` | 0 | 49.37 | 3 passed, 0 failed, 0 skipped |
| `npm run test:e2e:bi-plugin` | 0 | 137.81 | 3 passed, 0 failed, 1 skipped |
| `npm run test:plugins` | 0 | 59.52 | 9 passed, 0 failed, 0 skipped |
| `npm run test:bi-parity` | 0 | 95.61 | 2 passed, 0 failed, 0 skipped |
| `npm run test:e2e:capabilities` | 0 | 56.41 | 2 passed, 0 failed, 0 skipped |
| `npm run test:release:determinism` | 0 | 46.89 | 1 passed, two byte-identical standard ZIPs |
| `npm run test:release:determinism` with `OEP_TEST_BUNDLED=1` | 0 | 59.17 | 1 passed, two byte-identical bundled ZIPs and verified PDFium render |
| `npm run scan` | 0 | 1.88 | 962 files scanned with zero hits |

The standard release SHA-256 is `ff40d3d0bffa3f8f5557301de3cc18cb6d211030303fcfc8928344d5cae1923c`. The bundled ZIPs had SHA-256 `70cd2514487539a78128288399b12396e517452981441b11c4af83e312a8a68c`. The BI plugin SHA-256 is `2b806990939105f70c0078a8cc8ce532f1fb79f6d2f9ea387270436d094e587b`.

## Reviewer and owner follow-up

- The reviewer retains the dedicated Web HTTP, Excel, install, upgrade and backup gates, including the installed bundled-runtime campaign. The fresh-store and upgrade SQL fixtures ran in the contract gate.
- The restricted-token helper case remains available for a run that permits its integrity ACL changes. Both ACL-free helper cases passed, as did synthetic subscription sign-in in the contract and browser suites.
- The opt-in owner export, real technical scans and live Gateway, Telegram and provider-account acceptance remain for the owner. The synthetic BI tests cover the equivalent staged review, approved-origin intake and cited query flows.
