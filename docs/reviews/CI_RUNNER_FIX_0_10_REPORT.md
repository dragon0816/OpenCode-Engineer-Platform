# OEP 0.10 Windows runner fix

The branch `ci/fix-0.10-runner` starts at `2c00fbb`. Local verification used Windows 11 x64, Node 24.14.1, and Python 3.12.7.

## Root causes and fixes

- Phase 0 ran the reference-grant contract without installing the oracle dependencies. The contract uses `pypdf` to generate a fixture and the reference reader uses it to extract text. Phase 0 now selects Python 3.12 and installs `tests/oracles/requirements.txt` with `--require-hashes`, matching Windows release verification. The five packages installed and imported successfully in a fresh virtual environment.
- On the hosted runner, `TEMP` used an 8.3 spelling for the profile directory. The plugin registry joined that spelling into storage paths, which the strict workspace validator rejected when the native path resolved to its long spelling. The registry now canonicalizes the data root before deriving package and staging paths. The adapter also canonicalizes its optional plugin data root before passing it to recovery, document extraction, and the plugin runtime. Canonicalization uses the existing helper, which rejects reparse points and verifies the expanded path.
- The reference-grant contract passed the runner's short `TEMP` spelling to a mock file picker. The pinned reader deliberately rejects short-name selections. The contract and Chromium picker fixtures now use checked long paths. The contract verifies rejection of the raw alias when one is present. The reference service canonicalizes its protected data root so comparisons block the directory's long spelling even when the application supplied a short one.
- The Windows release run reported a 206.53 ms median for full-text search. The query plan iterated all passages in the publication and ran the FTS lookup for each row. `CROSS JOIN` makes SQLite evaluate the FTS matches once and look up each matching passage by rowid. The query retains the publication filter and ranking. The contract retains its 200 ms median limit.
- After the reference fix, the hosted Chromium step reached its second browser launch and hit `EBUSY` while reading `DevToolsActivePort`. The harness now retries an absent or locked port file within the existing startup deadline.

## Short-path reproduction

Use the [Windows runner alias setup](CI_RUNNER_FIX_REPORT.md#reproduction) with the Python virtual environment and the hashed oracle requirements installed. Set `TEMP` and `TMP` to the short spelling before running `node --test tests/contract/plugins.test.ts tests/contract/local-references.test.ts tests/contract/knowledge-browser.test.ts`. On the base commit the three plugin registry cases and the reference-grant case failed. With the fixes all nine tests passed. The local FTS median fell from 49.30 ms to 0.65 ms.

## GitHub Actions

| Run | Result |
| --- | --- |
| [Phase 0 verification 45214389407](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45214389407) | Baseline failed one reference-grant case and three plugin registry cases. |
| [Windows release verification 45214389312](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45214389312) | Baseline failed the reference grant and the knowledge browser latency contract. |
| [Phase 0 verification 45216001490](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45216001490) | Passed all steps and all 128 tests at `cce90e731acc5b5ebd2a974fe0ecf8b614b27454`. The FTS median was 2.07 ms. |
| [Windows release verification 45217357719](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45217357719) | Passed all required gates and artifact upload. The optional Chromium step timed out waiting for a reference from the picker fixture, which still supplied a short path in this run. |
| [Phase 0 verification 45218243644](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45218243644) | Passed after the Chromium reference fixture update. |
| [Windows release verification 45218243522](https://github.com/dragon0816/OpenCode-Engineer-Platform/actions/runs/45218243522) | Passed all required gates and artifact upload. Chromium passed its reference flow before hitting the port-file lock on the second launch. |

## Local verification

Worktree setup used `npm ci`, the pinned `.phase0/assets` and `.phase0/source` from the main checkout, and `node scripts/phase0/install-hooks.mjs`. The linked worktree inherited the primary worktree's hook snapshot setting. Setting this worktree's hook path to `.githooks` let the installer complete. Gates ran sequentially, each with a fresh `OEP_DATA_DIR`, the virtual environment first on `PATH`, and its Python executable in `OEP_PYTHON`.

| Command | Result |
| --- | --- |
| `npm run lint` | Passed. Checked 416 source and configuration files. |
| `npm run typecheck` | Passed. |
| `npm test` | Passed all 128 tests. The FTS median was 1.03 ms. |
| `npm run build:release` | Passed. Built and scanned `OEP-0.0.0-windows-x64.zip`. |
| `npm run test:plugins` | Passed all 9 tests. |
| `npm run test:e2e:capabilities` | Passed both tests. |
| `npm run test:release:determinism` | Passed. Both release archives had the same SHA-256. |
| `npm run scan` | Passed with 0 hits. |

The extra workflow commands `npm ci --ignore-scripts`, `npm run build`, `npm run test:ingest`, `npm run test:knowledge`, `npm run test:telegram`, and `npm run test:compliance` passed. The ZIP, plugin archive, SBOM and checksums were present. The OpenCode executable and API schema extracted from the ZIP matched the pinned assets used for the local Chromium gate.

The local `test:install`, `test:backup` and `test:upgrade` commands reached the maintenance guard, which detected a running OpenCode process and stopped the maintenance operations. The live process was left running. Windows release verification was temporarily enabled for the fix branch to exercise these gates on a clean host. The workflow's push trigger was then restored to `main`.

The local Chromium gate passed the native picker, pasted-path, and file-preview checks in Edge and Chrome. The full browser gate timed out later in those attempts. With a short `TEMP`, the browser stopped earlier when the workbook fixture's synthetic tool call was rejected by the model relay. A separate Chromium startup check injected `EBUSY` on the first port-file read and verified that the harness retried and connected to Edge. With that change, the full Edge gate passed locally in 255 seconds and reported zero orphan processes.
