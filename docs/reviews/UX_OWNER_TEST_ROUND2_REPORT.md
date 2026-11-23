# OEP 0.6.0 owner test, round 2

Branch `ux/owner-test-round-2` starts at `d11bdb9`. The owner reviews and merges locally.

## Root causes and fixes

| Owner finding | Root cause | Fix |
| --- | --- | --- |
| Telegram setup was hard to find for a new assistant | Settings rendered rows from the bot registry. An assistant without a bot could only be reached through the assignment selector after verifying a token in the global setup dialog. The detail tab linked back to Settings, and the wizard exposed the token fields directly. The global save message persisted in the Settings DOM. | Render one row per active assistant, plus a group for unassigned bots. Open the existing token setup from the row or detail tab with that assistant visibly selected. The wizard offers the same labeled entry and binds on creation. Keep bot management in each bot row and show save feedback briefly beside the affected item. |
| A note could not be deleted | The client already serialized `null`, and the adapter accepted it. The route required the message to appear in upstream history even when the local note already existed. A history failure or a message older than the returned window blocked removal. An in-flight state response could overwrite the local snapshot after a mutation, and the session notes panel offered no delete action. | Authorize deletion of an existing annotation by its scoped session and message keys, apply the persisted result immediately, and preserve it over an older refresh. Add Delete note to the panel, keep the message menu action, and preserve any rating and reason. |
| Pasted or dropped engineering files were rejected | Paste and drop reached the upload service. Its extension and declared MIME allowlist omitted engineering text formats, and the file picker used the same short extension list. HTML also took a separate rendered-preview path. | Normalize supported engineering text extensions to `text/plain`, accept common browser MIME labels, and retain strict UTF-8 and control-character validation. Reuse attachment limits and classification. Display HTML and engineering files as monospace source and list the supported categories in the rejection message. |
| Bold markup appeared literally in list items | The Markdown block renderer sent list item contents directly to `textContent` and grouped list markers without looking at indentation. | Use a shared inline renderer for list items, paragraphs, headings, and table cells. Preserve ordered and unordered nesting and build only DOM nodes and text. Link destinations are limited to HTTP and HTTPS. |

## Regression coverage and assertion changes

- Chromium checks the active assistant row count, the no-channel state, token setup preselection from Settings and Details, wizard token entry, and save feedback in the bot row. Existing button count, binding, archive, mapping, and responsive assertions follow the new assistant group and its nested bot rows. Assignment assertions now read the enclosing assistant heading because the per-bot duplicate assistant label was removed.
- Chromium creates and deletes a note through each UI and verifies the result after reload in Traditional Chinese and English at 1440 and 390 px. Existing export, filtering, rating, reply, cross-session, and direct route assertions remain. The route contract also covers unavailable history, explicit `null`, rejected empty or missing values, unknown messages, retained ratings, and deletion of the last field.
- Chromium pastes and drops `tsconfig.json` and a Python file, verifies auto-selection, the unclassified state and exact monospace text, and rejects binary contents with a `.json` extension. The type contract verifies every extension in the picker, supported browser MIME aliases, strict UTF-8 and control-character rejection, and unchanged binary signature checks. Existing HTML sandbox assertions now require literal source in `pre` and absence of iframe or script elements because HTML previews now display source. The assertion that the synthetic script never runs remains.
- Chromium verifies bold, italic, escaped markup, code spans, and a safe link inside nested lists. It retains the existing table, fenced code, and script and unsafe-link assertions.

## Verification environment

`npm ci` installed 14 packages with zero reported vulnerabilities. The worktree copied only `.phase0/assets` and `.phase0/source` from the main checkout. The hook installer rejected an inherited snapshot from outside this worktree. Setting the hook path to the checked-in `.githooks` at worktree scope let the installer activate its hooks and `merge.ff=false`.

Each command used a fresh temporary `OEP_DATA_DIR`. The verification venv was first on `PATH` and selected through `OEP_PYTHON` in the test process. Chromium and Telegram used synthetic services and credentials. The installed service and its data were outside this verification.

## Synthetic screenshots

The 14 PNGs cover the settings list and token setup dialog, the detail and wizard entry points, the Notes panel, an engineering text preview, and a formatted assistant reply. The links and PNG dimensions were checked for Traditional Chinese at 1440 × 900 and English at 390 × 844. [Workbench layout and gallery](../GUI_LAYOUT.md#060-擁有者驗收第二輪)

## Ordered gates

| Command | Exit | Seconds | Observed result |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.17 | 285 source and configuration files checked |
| `npm run typecheck` | 0 | 6.08 | TypeScript completed |
| `npm test` | 0 | 18.33 | 107 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 19.31 | Windows x64 ZIP built and passed its secret scan |
| `npm run test:e2e:browser`, run 1 | 0 | 149.49 | Chromium passed, 0 orphans, 14 screenshots captured |
| `npm run test:e2e:browser`, run 2 | 0 | 145.07 | Chromium passed, 0 orphans |
| `npm run test:e2e:browser`, run 3 | 0 | 144.93 | Chromium passed, 0 orphans |
| `npm run test:telegram` | 0 | 24.31 | 8 passed, 0 failed, 0 skipped |
| `npm run test:e2e:delegation` | 0 | 68.06 | 4 passed, 0 failed, 0 skipped, 0 orphans |
| `npm run test:e2e:knowledge` | 0 | 28.34 | Chromium and OpenCode MCP knowledge checks passed, 1 test |
| `npm run test:e2e:mcp` | 0 | 56.00 | MCP policy, process cleanup, HTTPS transport and Chromium leak checks passed |
| `npm run test:contract:native:isolation` | 0 | 24.16 | 5 passed, 0 failed, 0 skipped, 0 orphans |
| `npm run test:release:determinism` | 0 | 42.71 | 1 passed, both ZIPs matched the release build |
| `npm run scan` | 0 | 1.63 | 754 files scanned, 0 hits |

The release ZIP SHA-256 is `e9947f8effc0f0ccc958b00bc9bea54d054f5dd812fff428e814cb3f29774bc0`.

## Development attempts

- The first browser development pass exited 1 on the existing connection assertion after a reload. It cleaned up with zero orphans. The checkout changed during that development pass. The ordered gates use a fixed implementation revision.
- The annotation contract first returned 503 when the synthetic runtime failed to return the expected session profile. The fixture now echoes the requested profile, and the focused contract passed. The first ordered typecheck found the fixture lacked `createApi`. The fixture now provides an explicit guard against reaching Telegram, and the next typecheck passed.
- The first ordered `npm test` reached 106 of 107 passing tests. The catalog contract found two labels left behind by the empty bot list and rendered HTML preview. Both locales now omit those unused labels. The catalog assertion stayed in place.
- The next ordered run passed lint, typecheck, all 107 tests, and the release build. Chromium stopped at the existing plain-language audit because the attachment help exposed `UTF-8`. The help and unsupported-type message now say text files. The specific encoding error still gives the required format. The audit stayed in place.
- A Chromium retry reached the existing table and fenced-code assertion. The synthetic Markdown link reused the gateway's hostname, which caused the relay to redact the whole reply. The fixture now links to a separate reserved hostname. The existing reply, markup and redaction assertions stayed in place.
- The next development Chromium run passed, including the four new regressions, and shut down with zero orphans. Gallery review showed the selected assistant should be visible before token verification and that the global list style suppressed bullets. The final run checks both.

## Reviewer gates

The reviewer owns `test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, `test:backup`, and the merge. Clipboard files were synthetic Chromium events. Native Explorer clipboard integration was outside this run.
