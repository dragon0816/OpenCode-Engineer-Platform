# Phase 3I per-assistant model sources

`phase-3i/model-sources` branches from the requested `8de6a94` and merges `phase-3i/slice-2-cli` at `9c78471`. The branch is local. This review covers persisted model selection, authentication UI/API, and execution refusal while the production Windows boundary is pending.

## Delivered

- The assistant detail page, creation wizard, and composer group Gateway models and external coding agents. Enabled providers are selectable and disabled providers point to External Helpers. The composer changes the external source for the whole assistant. While the source is Gateway, the composer still changes the Gateway alias for the current session.
- The Web ledger is v9. Existing assistants, including Main and BI, retain their Gateway model and inherit the Gateway source. A new STRICT table stores explicit external selections. Upgrade reconciliation requires that table and checks its schema and initial emptiness. A stored external choice survives restart and provider unavailability.
- The settings view distinguishes owner enablement from execution availability. A verified installation can be enabled while signed out, so choosing it can open the sign-in dialog. Production still refuses new enablement when the dedicated Windows boundary is unavailable. The dialog states the public-data rule, shows signed-in, signed-out, and reauthentication states, and provides logout. Both catalogs include the new controls and errors.
- The paired authentication API validates its request and pins the provider executable before invoking an injected boundary. It returns a status without CLI output or the submitted key. The test boundary covers Codex ChatGPT and OpenAI API key modes, Claude Console key and official CLI modes, and logout. The real dedicated-account launch and credential writes remain pending.
- Web and Telegram refuse normal turns for an external-source assistant. The existing internal delegation path also excludes those targets at admission and execution. The configured source stays visible with a reason and a shortcut to External Helpers. The checkpoint's separate public-snapshot delegation path still runs both fake headless CLIs and verifies changed-file manifests in synthetic tests.

## Provider references

- Codex supports `codex login` for ChatGPT, `codex login --with-api-key` with the key on stdin, `codex login status`, and `codex logout`. The pinned invocation requests the CLI keyring and disables startup update checking. [OpenAI authentication](https://learn.chatgpt.com/docs/auth) · [OpenAI CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login)
- Claude Code accepts the owner’s Claude Console API key for API-billed usage and provides `claude auth login`, `claude auth status`, and `claude auth logout`. The official CLI option is for the owner running the genuine binary under an arrangement permitted by Anthropic. The Console API key is recommended for the OEP integration. [Anthropic authentication](https://code.claude.com/docs/en/iam) · [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

## Owner review steps

1. Use a disposable test root from this branch. Keep the installed OEP and its data outside the test. In PowerShell, run the following from the worktree. The commands use synthetic fixtures and the verification virtual environment.

   ```powershell
   $oepVerifyScripts = Join-Path $env:TEMP 'oep-verify-venv\Scripts'
   $env:Path = "$oepVerifyScripts;$env:Path"
   $env:OEP_PYTHON = Join-Path $oepVerifyScripts 'python.exe'
   $env:OEP_DATA_DIR = [IO.Directory]::CreateTempSubdirectory('oep-review-model-sources-').FullName
   npm run test:e2e:browser
   $env:OEP_DATA_DIR = [IO.Directory]::CreateTempSubdirectory('oep-review-helper-jobs-').FullName
   npm run test:e2e:external-helpers
   ```

2. In a disposable review build, open **Settings → External Helpers** and choose **Manage sign-in** or **Recheck status**. The build should report unverified Windows isolation and block authentication. Open **Assistant details → Model** and check the grouped options. In a fresh profile both providers show **enable in Settings**. An upgraded profile with a previously enabled provider can select it and see the isolation reason.

## Pending production setup and manual check

The owner setup and uninstall commands are pending. The planned setup is an explicit elevated action on a disposable Windows 11 host. It creates one non-admin local account, stores a generated launch password in Windows credentials, and grants access to the helper working-copy root. The verification must establish that the account can write there and is denied reads of sentinels in the owner profile and the OEP data root (`%LOCALAPPDATA%\OEP` by default). The Claude Console key belongs in the dedicated account's User-scope credential storage. Uninstall must remove the dedicated account and credential, revoke the ACL entries it added, and preserve the owner data. Keep real provider authentication and execution for review of that follow-up.

After the launcher and setup land, check the following on the separate host with synthetic public files. Sign in under the dedicated account and confirm the displayed status, perform one public request on each supported provider, check the reply and file manifest, then log out. Exercise Web, synthetic Telegram, and delegation. Verify that missing or confidential classifications block the run. Check that a missing private sentinel or one readable by the helper fails isolation verification. Run the owner uninstall and verify that the app reports isolation unavailable again.

## Assertions

The existing Web schema version expectations changed from v8 to v9, including the reviewer-owned upgrade test. The migration checks retain the previous ledger, rollback, and retention assertions and add checks for the empty source table and Gateway defaults. The merged browser test retains the main Telegram setup fixture and the checkpoint's public-snapshot confirmation and status assertions. The locale audit recognizes the official `Codex` and `Claude Code` product names alongside existing product names, allowing those exact spellings in both languages. The test still checks the translated disabled-option suffix. The existing Gateway browser assertions still require the same exact aliases in the Gateway group and now require the two disabled external entries in the complete list after each restart. The model chooser intentionally includes enabled and disabled external entries. New tests cover model groups, availability, persisted selection, synthetic authentication, and refusal without a verified production boundary.

## Development runs

- The first contract run passed 93 of 105. Two failures were stale Web schema assertions and catalog key usage. After updating the expected schema version and making the catalog references visible to the audit, a full run passed 95 of 105. A four-core retry passed 96 of 105. The remaining failures originated in the Windows workspace probe.
- A single-file diagnostic reproduced `ETIMEDOUT` at two seconds. Instrumented successful runs measured 6–9 ms inside the Python probe and up to about 2.1 s with the inline process launch. The same probe running from a script file completed in 38–65 ms over ten launches. The release now packages the script and retains the two-second deadline and the same ancestry, reparse, alternate-stream, and short-name checks. The targeted workspace suite passed 10 of 10, and the next unrestricted contract run passed 105 of 105.
- The first browser attempt reached the locale audit and failed because `Codex` was treated as untranslated prose. The Chromium supervisor reported zero orphans. The audit now recognizes the two official product names.
- A later browser attempt reached the new English composer scenario after 122.50 s and timed out waiting for the Traditional Chinese connection label after reload. The test now waits for the actual English label and the enabled composer control. This attempt also reported zero orphans.
- The next browser attempt passed the model-source and sign-in scenario, then the Gateway browser assertion compared every option with the old Gateway-only list. It failed after 120.59 s with zero orphans. The updated assertions verify the exact Gateway group and the exact complete list, including the newly required disabled providers.
- After two browser passes, the third run failed at 74.28 s while repeatedly reopening the Telegram assignment dialog. The test could reopen the shared dialog after `open` became false, while the prior close event still had to remove its controls. The readiness assertion now waits for that cleanup and still checks the resulting channel assignment. The failed run reported zero orphans.

## Verification

Windows 11 x64 and Node 24.14.1. `npm ci` installed 14 packages. Phase 0 assets and source were copied from the main checkout, and the Phase 0 hook installer confirmed the active worktree hooks. Each gate used a fresh temporary `OEP_DATA_DIR` and process-local `oep-verify-venv` Python. The implementation is `bc8b31c`. The third browser retry includes the test synchronization change in `7e12a75`.

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 295 source and configuration files checked | 1.11 |
| `npm run typecheck` | 0 | TypeScript completed | 6.22 |
| `npm test` | 0 | 105 passed, 0 failed, 0 skipped | 17.60 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 18.66 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium passed, 0 orphans | 136.88 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium passed, 0 orphans | 138.52 |
| `npm run test:e2e:browser`, run 3 retry | 0 | Chromium passed, 0 orphans | 139.41 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 31.10 |
| `npm run test:telegram` | 0 | 8 passed, including external-source refusal | 27.39 |
| `npm run test:e2e:mcp` | 0 | Broker scope, isolated probes, HTTPS transport, and Chromium passed | 83.45 |
| `npm run test:contract:native:isolation` | 0 | 5 passed, 0 orphans in the existing OpenCode isolation contract | 30.28 |
| `npm run test:e2e:delegation` | 0 | 4 passed, 0 orphans | 72.24 |
| `npm run test:e2e:external-helpers` | 0 | 8 passed, including confinement, cancellation, timeout, and restart | 129.49 |
| `npm run test:release:determinism` | 0 | 1 passed, two byte-identical ZIPs | 41.49 |
| `npm run scan` | 0 | 750 files, 0 hits | 1.79 |

The release ZIP SHA-256 is `a091dc4503cc2c27480708871ec01562ff69f0560b4aa632473aca5d186fcd8c`. The migration, workspace probe, sign-in Web module, and both catalogs were verified byte for byte in the archive.

The installed OEP, its data, and real provider accounts and Windows accounts were outside this verification. `test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup` are reserved for reviewer verification.
