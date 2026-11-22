# Windows CI runner failure report

Branch `ci/fix-runner-failures`, based on `f0dbe06`. Local reproduction used Windows 11, Node 24.14.1, PowerShell 7.6.10, and Python 3.12.7.

## Root cause

- The phase 3B workspace validator compared the caller's path spelling with Node's native realpath. On Windows, `realpathSync.native` expands an NTFS 8.3 alias to the long name. The dispatcher hit that comparison at adapter startup, and the model-switch contract hit it when creating a session. Both failed before reaching their subject under test. A real short-name temp path reproduced the two CI stacks on the same volume as the checkout. The hosted temp path spelling was unrecorded in the logs. [Win32 long-name expansion](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew)
- The snapshot test built a prepared upgrade journal in JavaScript with the raw temp path. PowerShell's `Root-OEP` expanded the short name through `[IO.Path]::GetFullPath`. The journal root comparison correctly rejected the mismatch, so the failure handler reported a secondary journal error after reporting the corrupt database. Production upgrade and rollback scripts write the root after `Root-OEP`.

## Reproduction

Run this in a separate PowerShell session at the repository root. Use a temp volume that creates 8.3 aliases.

```powershell
$env:OEP_PYTHON = Join-Path $env:TEMP 'oep-verify-venv\Scripts\python.exe'
$env:PATH = "$(Split-Path $env:OEP_PYTHON);$env:PATH"
$longTemp = (New-Item -ItemType Directory (Join-Path $env:TEMP ("OEP Runner Alias Fixture " + [guid]::NewGuid()))).FullName
$shortTemp = & $env:OEP_PYTHON -I -c 'import ctypes, sys; buf = ctypes.create_unicode_buffer(32768); assert ctypes.windll.kernel32.GetShortPathNameW(sys.argv[1], buf, len(buf)); print(buf.value)' $longTemp
if ($shortTemp -eq $longTemp) { throw 'The temp volume did not create a short name.' }
$env:TEMP = $env:TMP = $shortTemp
Remove-Item Env:OEP_DATA_DIR -ErrorAction SilentlyContinue
node --test --test-name-pattern 'snapshot diagnostics|restart inspects|a session with a removed model' tests/contract/data-snapshot.test.ts tests/contract/dispatcher.test.ts tests/contract/gateway-models.test.ts
```

At `f0dbe06`, all three tests failed. The snapshot printed both `【web/web.sqlite】SQLite 結構、筆數或發布修訂讀取失敗。` and `【upgrade.journal.json】無法寫入升級或回退的失敗紀錄。`. The other two raised `Workspace file is missing, unsafe, or changed` at the realpath comparison. All three passed under the same alias after the changes.

## Changes

- The launcher, adapter, and chat service use a checked long-form data root for workspace paths. The Windows check rejects reparse points along the supplied path before asking `GetLongPathNameW` to expand it, then matches that independent result against Node's native realpath. Strict path comparisons still apply to externally selected project folders and controlled files. The regression test checks a real short alias where available and rejects a real junction.
- The snapshot fixture writes the prepared journal with `Write-OEP` and the normalized `$DataRoot`, mirroring production. The console diagnostic, lock cleanup diagnostic, maintenance log, journal message, and journal state assertions remain in force.

## GitHub Actions

| Run | Result |
| --- | --- |
| [Phase 0 verification 45083626994](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45083626994) | Baseline failed all three contracts. |
| [Windows release verification 45083627078](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45083627078) | Baseline failed the snapshot and dispatcher contracts. The model-switch contract passed in this workflow, which sets `OEP_DATA_DIR` from `RUNNER_TEMP`. |
| [Phase 0 verification 45084278850](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45084278850) | Passed at `483f18561793f1f04841161f1cbdc5558afcd83c`. All 99 tests and every workflow step passed. |

The hosted checkout volume did not create a short name for the new workspace fixture. Its junction assertion ran on the hosted runner, and both assertions ran locally on the system volume.

## Local verification

Worktree setup used `npm ci`, the pinned OpenCode assets and source copied from the main checkout, and `node scripts/phase0/install-hooks.mjs`. The linked worktree inherited the main checkout's hook snapshot setting. Setting its worktree-local hook path to `.githooks` let the installer run successfully.

The gates ran in sequence with a fresh temporary `OEP_DATA_DIR` for each command. Python used `%TEMP%\oep-verify-venv\Scripts` first on `PATH` and its `python.exe` as `OEP_PYTHON`.

| Command | Result |
| --- | --- |
| `npm run lint` | Passed. Checked 269 source and configuration files. |
| `npm run typecheck` | Passed. |
| `npm test` | Passed. 99 tests. |
| `npm run build:release` | Passed. Built and scanned `OEP-0.0.0-windows-x64.zip`. |
| `npm run test:e2e:browser` | Passed. The runtime reported child exit 0 and zero orphans. |
| `npm run test:contract:native:isolation` | Passed. 5 tests. |
| `npm run test:e2e:delegation` | Passed. 4 tests. |
| `npm run scan` | Passed. 0 hits. |
