# Phase 3I slice 2 Windows helper execution checkpoint

Branch `phase-3i/slice-2-cli`, based on `107debe`. Both helpers remain disabled in the released adapter. The branch implements the delegation worker and exercises it using synthetic CLI scripts on Windows. Production still requires the privileged launcher and independently verified egress policy from the design.

## Delivered

- The external worker claims the existing delegation lease and checks the approved provider, parent run, snapshot, settings revision, classification, bytes, and Claude terms. It rechecks the gate immediately before the boundary releases the task and writes the launch intent, gate receipt, and full reserved request and tool charge in one transaction. Zero turn tool budget blocks launch. The deadline covers probing, staging, execution, and verification. Claude receives the lower of the request reservation and the turn tool limit as its turn cap.
- The per-run directory is `web/agents/<helper>/external/<run-id>/`. OEP stages selected workspace files into `work/` and supporting material into `work/oep-inputs/`. The executor reuses exclusive handle-based Windows writes, verifies SHA-256, and rejects provider startup files and unsafe names. The synthetic boundary labels the reference directory read-only for the guest. Separate baseline metadata stays in the run directory. Original baseline bytes remain in the verified snapshot.
- The provider contracts use fixed argv, bounded stdout, controlled stdin, and an environment built from an explicit Windows runtime path, dedicated profile locations, per-run scratch, and provider-specific login state locations. CLI output is parsed for protocol and completion signals. Audit events contain version, gate revision, source count, budget, stop counts, and fixed failure reasons. Login fields and raw stdout/stderr are discarded. The delegation summary is derived locally from the verified change count.
- On verified success, the executor compares the staged baseline against the stopped Job's copy and writes `changed-files.json` with relative paths and before/after SHA-256 values. The result receipt stores the manifest digest and change count. Changed bytes stay in `work/`. Failed runs with verified stop are discarded when cleanup succeeds. Unverifiable stop or cleanup retains the lease as `indeterminate` and blocks replay and generic owner resolution.
- Settings displays localized installation, login, Windows isolation, installed version, and required version states in zh-TW and en. A paired owner can recheck status. With no verified boundary installed, settings reports status unchecked and Windows isolation unverified, and the server refuses enabling, intake, and confirmation. Existing per-run confirmation defaults remain on.

## CLI contract review

The official references were checked for the headless arguments on 2026-11-23. Installed-binary compatibility remains pending.

- **Codex** uses `--ask-for-approval never exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox workspace-write --skip-git-repo-check -` with fixed `-c` overrides. These select the Windows `mxc` sandbox, keyring authentication, and disabled workspace-command networking, web search, hooks, plugins, apps, memories, goals, multi-agent, and update checks. The isolated login probe uses `login status` with the same keyring setting. Fix the activated version by digest and verify effective MCP, Skills, and project configuration before deployment. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) · [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) · [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [Authentication](https://learn.chatgpt.com/docs/auth)
- **Claude Code** uses `--print --input-format text --output-format json --no-session-persistence --safe-mode --restricted --permission-mode dontAsk --tools Read,Glob,Grep,Edit,Write --allowedTools Read,Glob,Grep,Edit,Write --disallowedTools "mcp__*" --max-turns <n>`. The official reference lists `--restricted` from 2.1.248 and says managed policy can still take effect in safe mode. `auth status` uses the native login and accepts the supported `claude.ai` authentication type. The fixture's `1.2.3` identifies only synthetic output. [CLI reference](https://code.claude.com/docs/en/cli-reference) · [Headless mode](https://code.claude.com/docs/en/headless) · [Authentication](https://code.claude.com/docs/en/iam) · [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)

## Owner steps for this branch

1. Open **設定 > 外部幫手** in a review build launched against a disposable OEP data root. Select **重新檢查狀態** for each provider. Both must stay disabled with the Windows isolation reason.
2. For the implemented synthetic path, open the worktree in PowerShell and run the following. It uses the existing verification venv and a new temporary data root. It creates no Windows user or AppContainer profile, applies labels only within the temporary test root, and uses no provider account.

   ```powershell
   $venv = Join-Path $env:TEMP 'oep-verify-venv\Scripts'
   $env:Path = "$venv;$env:Path"
   $env:OEP_PYTHON = Join-Path $venv 'python.exe'
   $env:OEP_DATA_DIR = [IO.Directory]::CreateTempSubdirectory('oep-review-helpers-').FullName
   npm run test:e2e:external-helpers
   ```

Production provisioning has no command in this checkpoint. The remaining setup needs an administrator action on a dedicated test host to create two non-admin identities and clean profiles, install a controlled launcher and owner-only IPC, provision executable and per-run ACLs, and install a default-deny per-identity/per-executable network policy with TLS hostname enforcement. The launcher must verify these controls and refuse to run when they change. The synthetic launcher and test labels do not supply those production controls. [Restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens) · [Windows Filtering Platform](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-start-page)

## Manual real-account check after production provisioning

1. Use a separate Windows 11 test host with synthetic public files and an isolated OEP data root. Verify the launcher and provider identity, the CLI's native `.exe` architecture and release digest or signature, and file identity through launch. Capture the verified `--version` and compare the headless `--help` against the fixed argv. Complete the terms review before authorizing Claude.
2. Under each dedicated provider Windows account, run the pinned absolute native executable with `codex login` or `claude auth login` as applicable. Use the same dedicated `CODEX_HOME` and `cli_auth_credentials_store="keyring"` or `CLAUDE_CONFIG_DIR` as the launcher. Use the vendor's interactive login and the temporary login egress policy. Close that policy before execution. Confirm the installed and signed-in states in **設定 > 外部幫手**. Record only statuses, version, durations, and necessary provider endpoint names.
3. With synthetic canaries, verify guest denials for original files, other runs, registry, processes, IPC, and network shares. Verify HTTPS/WSS access to the approved vendor hosts and denial of unapproved DNS, direct IP, same-IP alternate hostnames, loopback, private and IPv6 routes, child-process egress, and managed configuration overrides. For Codex, verify subprocess containment and denial of access to login storage. For Claude, verify effective managed settings and that hooks cannot reintroduce executable tools. Exercise cancellation and launcher loss and confirm zero live Job members.
4. Mark a synthetic workspace and one source public. Confirm one short edit request each. Check the changed-file digest and confirm the original file remains intact. Recheck login after a vendor credential refresh, run the vendor logout, and verify that OEP blocks further executions. Perform the diff and download checks once slice 3 implements that UI.

## Test coverage and assertion changes

- Automated tests use Node-based fake Codex and Claude CLIs, temporary roots and profile paths, a suspended Windows Job with kill-on-close, and a low-integrity restricted test token. The fake checks exact selected flags, stdin, and environment keys. Native probes check denied canary reads/writes, denied writes to the private baseline and read-only reference, allowed edits in the working copy, and Job membership and zero live descendants. The no-read-up label is explicit on the test canary.
- The fixture exercises malformed output, nonzero exit, stdout flood, alternate data streams, deadline, owner cancel, lost supervisor, recovery without replay, version digest change, login states, zero budget, changed bytes after confirmation, and Claude terms. The existing Slice 1 browser exercises the same confirmation and queue assertions against an explicit intake fixture, so production can remain locked while browser coverage exercises both localized status states. The paired API test verifies production refusal.
- During development, an unregistered AppContainer start returned Win32 error 2. That path was dropped to honor the requirement against creating profiles or modifying settings beyond the test root. The loopback socket assertion from that attempt was removed because the replacement low-integrity fixture provides file access checks and Job cleanup without WFP. Production network negatives remain pending. Early same-user restricting-SID variants also failed Windows runtime initialization. The checked-in fixture uses a low-integrity token with temporary mandatory integrity labels.
- The initial fixture counted three total Job processes. Windows also placed console hosts in the Job, producing six. The test now checks both actual spawned descendant IDs against observed Job membership, requires at least three total members, and still requires zero live members after cleanup. Exit `EPERM` and `EACCES` both count as filesystem denials. ACL changes update NTFS metadata, so read-only verification checks pinned device, inode, creation time, length, and SHA-256 after staging. The final request assertion reads the existing typed terminal result field.

## Verification

Windows 11 x64 and Node 24.14.1. `npm ci` installed 14 packages and reported zero vulnerabilities. Phase 0 `assets` and `source` came from main. The hook installer initially rejected the inherited absolute hook snapshot from a different worktree. Repointing this worktree's `core.hooksPath` to the checked-in `.githooks` let the installer confirm both active hooks and `merge.ff=false`. Each gate received a fresh `OEP_DATA_DIR` with verification Python configured for its process.

- The first ordered attempt passed lint and stopped at a TypeScript narrowing error in the new test. The test now reads the terminal result directly.
- The second ordered attempt passed lint, typecheck, all 103 contracts, and the release build. Its first browser run exited 1 after 42.68 s because the existing contrast gate could no longer find the external settings help paragraph. Browser shutdown reported zero orphans. The paragraph now explains the dedicated account requirement, and the contrast assertion is preserved.
- The next ordered attempt reached the browser locale gate. It exited 1 after 42.68 s when the zh-TW settings displayed the untranslated `CLI` label. Shutdown again reported zero orphans. The label now uses the Traditional Chinese term for a command-line program. The locale assertion is preserved.
- The first low-integrity fixture ran the fake executables and passed the readiness, source change, exit and output limit, and budget checks. Its success and cancellation tests initially failed because the fixture expected only three Windows Job members and pinned ACL-sensitive NTFS metadata before labels were applied. Subsequent iterations verified the actual descendant IDs and preserved the source hashes and file identities across ACL setup.
- The focused helper rerun passed 8 of 8 tests in 103.68 s, including the lost-supervisor and restart assertions.

The ordered sequence ran on implementation commit `c3e1e455dcc0e33942dd585499fed02afd06a75a`.

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 287 source and configuration files checked | 1.12 |
| `npm run typecheck` | 0 | TypeScript completed | 5.41 |
| `npm test` | 0 | 103 passed, 0 failed, 0 skipped | 19.80 |
| `npm run build:release` | 0 | Windows x64 ZIP built and scanned | 17.56 |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium passed, 0 orphans | 170.50 |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium passed, 0 orphans | 172.75 |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium passed, 0 orphans | 175.62 |
| `npm run test:e2e:knowledge` | 0 | 1 passed | 36.29 |
| `npm run test:ingest` | 0 | 16 passed | 4.21 |
| `npm run test:telegram` | 0 | 8 passed | 35.38 |
| `npm run test:e2e:mcp` | 0 | Broker scopes, isolated probes, HTTPS transport, and Chromium passed | 79.10 |
| `npm run test:compliance` | 0 | 2 passed | 0.43 |
| `npm run test:release:determinism` | 0 | 1 passed, identical ZIPs | 38.48 |
| `npm run test:contract:native:isolation` | 0 | 5 passed, 0 orphans | 21.88 |
| `npm run test:e2e:delegation` | 0 | 4 passed, 0 orphans | 92.09 |
| `npm run scan` | 0 | 727 files, 0 hits | 1.52 |
| `npm run test:e2e:external-helpers` | 0 | 8 passed, 0 failed, 0 skipped | 105.52 |

The release build and both determinism builds produced SHA-256 `12304ef42dd5289e84486ad601e5b51855ff6f5d08ae978692e34cb7ad9bfdaa`. Eight packaged entries matched the worktree byte for byte, including the executor, CLI contract, copy verifier, worker, settings UI, both catalogs, and Windows Job implementation.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`. The installed OEP and its data directory were outside test scope. The branch is local for review and merge.

## Remaining work

- Implement and independently verify the one-time owner-approved Windows provisioning, controlled launcher, restricted identities and desktop, OS egress and TLS hostname filtering, provider-native discovery and validated binary allowlist. Validate each supported native CLI and login in the production boundary before that provider can be enabled.
- Add production on-disk scratch quota enforcement and restart reconciliation backed by durable launcher and network stop receipts. The checkpoint retains uncertain leases and working directories for later reconciliation. Add local delegated child session and run records beyond the existing work item and delegation receipt.
- Extend staging to supported public attachments whose names fall outside the current scoped-path ASCII name rules.
- Slice 3 still owns verified diffs, full file export and downloads, and the manually applied result workflow.
