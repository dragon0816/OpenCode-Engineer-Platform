# OEP assistant management

Local branch `ux/agent-management` starts at `98bb812` from `ux/composer-drop-paste`. The owner reviews and merges the branch.

## Changes

- Assistant details and the rail menu offer Delete assistant for owner-created assistants. Confirmation explains what happens to bots, conversations and restore. The archive transaction unassigns bots before changing assistant state. It waits for queued work, live work and pending bot deliveries. The collapsed Deleted assistants section contains Web conversations and a read-only text view of Telegram conversations. Restore reactivates the assistant and its workspace. Bot assignment is a separate owner action.
- Assistants and channels shows each bot, its assistant, and plain status and next-step text. Manage contains assignment, replacement, recheck and removal. Assignment changes require confirmation. Display names are remembered in Web SQLite, including when a bot is unassigned or Telegram is offline. Reply language is editable in assistant details.
- The wizard and Add Telegram bot share a masked token editor. The adapter uses `getMe` to identify the bot. A short-lived setup belongs to its paired browser. Initial owner enrollment accepts a fresh `/start` from a private chat and shows the sender name for confirmation. On save, the token goes to Windows User scope through the existing stdin credential helper. The registry stores a generated reference and identity seal. Ordinary settings responses omit references. Advanced computes the managed reference locally in the browser. Legacy references remain usable.
- Delegation limit offers Lean, Standard and Relaxed. Standard preserves the original limits. Advanced shows each exact count and both times in minutes. Saved custom milliseconds round-trip without change. Central SQLite v8 adds empty tables for bot display and removal state and for preset choice. Existing conversation, binding and budget rows are preserved.

## Tests and assertion changes

- The browser suite exercises masked token setup with a synthetic Telegram identity, a rejected group start, private owner confirmation, duplicate rejection, adding a second bot, existing token display, assignment confirmation, recheck, removal, deletion from both entry points, restore, built-in protection, and read-only Web conversations. The agent API contract checks paired, read-only access to the deleted assistant’s Telegram history. The browser reloads each preset and an older custom budget, and checks exact counts and minute values. Mapping, locale and theme checks cover wide and narrow workbench layouts.
- Earlier channel table selectors were replaced because the table became a list and the row actions moved to Manage. The duplicate, rebind, unbind, and narrow-layout checks have corresponding assertions against the new controls. The archived-session locator moved from the active session rail to Deleted assistants. The original read-only chat assertion and archive busy and built-in API assertions remain.
- The Telegram integration assertion that read the winning legacy reference from the channel API now reads it directly from the synthetic registry. It still verifies the winning reference, duplicate response, rotation, and token redaction. It also checks that the settings API omits reference fields. The new credential contract checks the temporary setup, paired-browser ownership, consent, generated reference, token replacement, removal, re-enrollment, and absence of the token from API responses, databases and file logs.
- Version assertions changed from central Web v7 to v8. Existing seed, upgrade, counts, rollback and integrity assertions remain. The allowlist contract also verifies both new tables start empty, and the historical custom budget is unchanged.
- The Traditional Chinese language check accepts `bot`, `token`, `BotFather`, `/start`, and Telegram handles only inside assistant and channel settings surfaces. The requested labels retain those Telegram terms. The same check still rejects other English UI words in those surfaces and applies its original rules elsewhere.

## Verification

`npm ci` installed 14 packages and reported zero vulnerabilities. The worktree uses copies of `.phase0/assets` and `.phase0/source` from the main checkout. The hook installer initially rejected the inherited hook snapshot. Selecting the checked-in `.githooks` at worktree scope let the installer activate the hooks and set `merge.ff=false`.

Every gate uses a fresh temporary `OEP_DATA_DIR` and the process-local verification Python. The Telegram and browser clients use synthetic bots and an in-memory credential environment. The installed OEP and its data were outside this verification.

### Ordered gates

Implementation and test revision `0b22dcf`.

| Gate | Exit | Time | Observed result |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.13 s | 283 source and configuration files checked |
| `npm run typecheck` | 0 | 4.82 s | TypeScript completed |
| `npm test` | 0 | 15.86 s | 104 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 14.88 s | Windows x64 ZIP built and passed its secret scan |
| `npm run test:e2e:browser`, run 1 | 0 | 114.46 s | Chromium passed, 0 orphans |
| `npm run test:e2e:browser`, run 2 | 0 | 120.46 s | Chromium passed, 0 orphans |
| `npm run test:e2e:browser`, run 3 | 0 | 119.15 s | Chromium passed, 0 orphans |
| `npm run test:telegram` | 0 | 24.18 s | 8 passed, 0 failed, 0 skipped |
| `npm run test:e2e:delegation` | 0 | 63.56 s | 4 passed, 0 failed, 0 skipped, 0 orphans |
| `npm run test:e2e:mcp` | 0 | 53.16 s | MCP policy, isolated probes, HTTPS transport and browser leak checks passed |
| `npm run test:contract:native:isolation` | 0 | 22.68 s | 5 passed, 0 failed, 0 skipped, 0 orphans |
| `npm run test:release:determinism` | 0 | 33.72 s | 1 passed. Both ZIPs matched the release build. |
| `npm run scan` | 0 | 1.49 s | 737 files scanned, 0 hits |

Release ZIP SHA-256 is `67184aef9cf91a0e4d9defa487b642f40395f1ccc5a3e716e817c7ddf8f52433`.

## Synthetic screenshots

Chromium captured the gallery during the `16023d7` verification pass. The following commit changed only credential injection for the MCP test.

| View | Traditional Chinese, wide, light | English, narrow, dark |
| --- | --- | --- |
| Channel list | [Wide list](../validation/gui/ux-agent-channels-zh-TW-wide-light.png) | [Narrow list](../validation/gui/ux-agent-channels-en-narrow-dark.png) |
| Manage bot | [Wide dialog](../validation/gui/ux-agent-channel-manage-zh-TW-wide-light.png) | [Narrow dialog](../validation/gui/ux-agent-channel-manage-en-narrow-dark.png) |
| Wizard channels | [Wide step](../validation/gui/ux-agent-wizard-channel-zh-TW-wide-light.png) | [Narrow step](../validation/gui/ux-agent-wizard-channel-en-narrow-dark.png) |
| Assistant details | [Wide details](../validation/gui/ux-agent-detail-zh-TW-wide-light.png) | [Narrow details](../validation/gui/ux-agent-detail-en-narrow-dark.png) |
| Delete assistant | [Wide confirmation](../validation/gui/ux-agent-delete-zh-TW-wide-light.png) | [Narrow confirmation](../validation/gui/ux-agent-delete-en-narrow-dark.png) |
| Delegation limit | [Wide limits](../validation/gui/ux-agent-budget-zh-TW-wide-light.png) | [Narrow limits](../validation/gui/ux-agent-budget-en-narrow-dark.png) |

## Development attempts

- The first typecheck rejected TypeScript parameter-property syntax in the synthetic browser client. An explicit property fixed it. The next contract run found three v7 assumptions in the migration fixtures. They now verify v8 and include the new tables in the upgrade allowlist. A later contract run found the missing Close label for the Telegram transcript. Both catalogs now include it, and the next run passed 104 of 104 tests.
- The first Chromium run exited 1 after 26.79 seconds. The Traditional Chinese UI-text test stopped on `bot` in the channel settings help. The catalog uses Chinese phrasing where possible, and the language check recognizes the requested Telegram setup terms in the scoped surfaces described above.
- A Chromium retry exited 1 after 82.91 seconds at the delete-and-reopen scenario. The dialog now ignores a delayed close event from a previous opening, and the test requires the confirmed delete to close without a server error. A subsequent run exercised deletion, unassignment and read-only Web history, then exited 1 after 69.50 seconds because its restore click raced the detail request. The test now waits for the restore control to become visible.
- The next Chromium run exited 1 after 82.50 seconds. The synthetic registry showed the assistant had been restored, and the exact UI assertion expected the success text without its closing punctuation. The assertion now matches the catalog text exactly.
- An ordered pass at `16023d7` passed lint, typecheck, all 104 tests, the release build, three Chromium runs, Telegram, and delegation. The existing MCP browser leak fixture would write its marker through Windows User scope. A guard stopped that run before the credential action, and `test:e2e:mcp` exited 1 after 33.52 seconds. The fixture now injects the shared credential environment, with the probe receiving the marker only through its process environment. Its existing child, API, DOM, log, restart and cleanup assertions remain. The focused Chromium leak check and the full MCP gate passed with the injected store.

## Reviewer gates

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`.
