# Phase 3I per-assistant model sources

`phase-3i/model-sources` branches from the requested `8de6a94` and merges `phase-3i/slice-2-cli` at `9c78471`. The branch is local. This review covers persisted model selection, authentication UI/API, and execution refusal while the production Windows boundary is pending.

## Dedicated Windows account on `phase-3i/model-sources-2`

The follow-up starts at `81ba31b`. The Windows launcher uses the owner-managed account for sign-in, status, sign-out, and the existing public-snapshot delegation path. It verifies the alternate account SID, checks for Administrators membership, removes the token's bypass-traverse privilege, requires access-denied results for the protected sentinels, and tests writes in the working copy and scratch directory. The helper executable and its descendants run in a kill-on-close Job. A pinned provider binary stays open without write or delete sharing during the operation. The adapter revalidates the snapshot at the release handshake, before the helper starts the provider process.

The alternate account gets read and execute access to the managed runtime and access to its active working copy. OEP makes the reference directory read-only and revokes access to the copy after the Job stops. The account has its own Windows profile for provider credentials. The account's launch password lives in the OEP owner's Credential Manager, and the Claude Console key, when configured, lives in the helper's Credential Manager. The launcher sends provider API keys through a private stdin pipe. It displays official interactive login in a console under the helper account. [Windows alternate-credential process API](https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw) · [Windows credential persistence](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)

### Owner setup and removal

1. Use a separate Windows 11 x64 review host or VM with an OEP owner account that can approve UAC as itself. Initialize the review build's OEP data directory under that account. The default is `%LOCALAPPDATA%\OEP`. For a custom location, both the default and custom directories must exist under the same owner profile.
2. Obtain the standalone Windows x64 provider executable from its official distribution and record the reviewed three-part version and lowercase SHA-256. Run the following in **64-bit Windows PowerShell as administrator**, under the same Windows identity that runs OEP. Run from the review checkout or extracted release root. Supply one complete set of arguments per provider you want to configure.

   ```powershell
   $codexExe = 'C:\review\providers\codex.exe'
   $codexVersion = '<reviewed three-part version>'
   $codexSha256 = '<reviewed lowercase SHA-256>'
   .\scripts\windows\Setup-OEPExternalHelper.ps1 -CodexExe $codexExe -CodexVersion $codexVersion -CodexSha256 $codexSha256

   $claudeExe = 'C:\review\providers\claude.exe'
   $claudeVersion = '<reviewed three-part version>'
   $claudeSha256 = '<reviewed lowercase SHA-256>'
   .\scripts\windows\Setup-OEPExternalHelper.ps1 -ClaudeExe $claudeExe -ClaudeVersion $claudeVersion -ClaudeSha256 $claudeSha256
   ```

   Append `-DataRoot 'C:\absolute\path\inside\owner-profile'` on every setup invocation if the review build uses a custom directory. Rerun with the same arguments to repair or refresh the setup. A provider omitted on a repeat invocation retains its existing pin.

3. Setup creates the non-admin local user `OEPExternalHelper` and its Windows profile, one local-machine-persistent generic credential in the owner's Credential Manager, and `HKLM\SOFTWARE\OEP\ExternalHelper` with the deployment metadata. It creates `%ProgramData%\OEP-ExternalHelper\runtime` for the trusted launcher and pinned provider executables and `%ProgramData%\OEP-ExternalHelper\runs` for working copies. It adds a non-inheriting deny ACE for the helper SID to the owner profile and the default and configured data roots. It places an `.oep-external-helper-sentinel` in each of those roots. The sentinel's read grant makes the probe test whether the account can traverse the protected root.
4. In OEP, open **Settings → External Helpers** and choose **Check status**. Verify the required version and Windows isolation. Accept the provider warning, enable the provider, and sign in. For Claude Code, first confirm the provider terms and use a Console API key, or use the official CLI as permitted by the applicable agreement. Keep key material out of PowerShell commands.
5. Run the uninstaller from the same elevated owner PowerShell when the helper is idle. It removes the helper SID's deny ACEs and sentinels, the local account and profile (including its provider sign-ins), the owner's launch credential, the helper files and working copies under ProgramData, and the helper registry key. Keep any needed output before removal. The owner profile, OEP data, and source provider binaries are preserved.

   ```powershell
   .\scripts\windows\Uninstall-OEPExternalHelper.ps1
   ```

### Manual verification on the review host

- Before setup, check that sign-in and enablement require verified Windows isolation. After setup, repeat the same setup command. Check that the local account SID stays the same and belongs only to the local Users group.
- Check both providers with a published executable and the reviewed pin. A missing provider should report a missing CLI after isolation has passed. Recheck after temporarily renaming a private sentinel on the disposable host. Isolation should fail. Restore the sentinel and recheck. On the disposable host, also check that a readable sentinel causes failure and rerun setup to restore protection.
- Check Codex API-key sign-in, the official interactive sign-in in the helper console, and sign-out. Check Claude Console API-key sign-in, permitted official CLI sign-in, and sign-out. Repeat status checks after reopening OEP. Saving a Claude Console key verifies the stored credential is present. Provider acceptance is exercised by a real request on the review host.
- Submit one synthetic public snapshot through **Prepare external delegation**. Confirm it, check the terminal state and changed-file count, and verify the CLI Job is gone. Check that unclassified, confidential, and changed input never starts the CLI.
- Uninstall twice. Confirm the helper account, helper profile, generic credential entry, ProgramData directory, registry key, and sentinel files have been removed. Confirm OEP data is still present and **Check status** again reports unverified Windows isolation.

### Remaining execution work

External-source assistants still refuse standard Web and Telegram turns, and the internal delegation path still refuses external-source targets. The existing public-snapshot delegation path runs through the Windows boundary. Phase D still needs the normal chat and delegation routing, external reply bubbles and verified downloads, and the public-vault and controlled-file MCP bridge. Genuine alternate logon, effective ACL behavior, and provider compatibility remain owner review items on the separate host.

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

## Original checkpoint scope

At `81ba31b`, the owner setup and uninstall scripts, native alternate-account launching, and production verification were pending. The follow-up above records the owner setup and the open execution work.

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
