# Capabilities page for the Thursday demo

## Why the owner could miss 能力

The 0.9.0 source at `81aa701` put 能力 inside the collapsible 主功能 group. A saved collapsed state hid the entire group after reload. The HTML also initialized 能力 as disabled. The page enabled it only after bootstrap, assistant discovery, and every assistant workspace’s session list succeeded. A failed or slow session list could leave the entry disabled. This diagnosis comes from the source and the isolated browser regression test.

The entry now remains visible in 主功能 while its disclosure is collapsed. Its navigation works independently of session loading. Opening the page focuses the heading and selects Plugin, where the primary button opens the file picker. A drop anywhere on the page opens the same package preview and permission-confirmation flow.

## Demo paths

| Tab | What to show |
|---|---|
| Plugin | Open **從檔案安裝** or drop a single `.oepplugin`. Review its permissions and compatibility, accept the install, and check the installed list. |
| Skill | Install a local folder or ZIP with `SKILL.md`, select an assistant, and toggle the installed Skill. OEP warns when enabling more than 20. Use **解除安裝** to remove the package and its grants. |
| Workflow | Import an AEP JSON manifest and expand its definition to see parameters and steps. The tab shows **執行功能即將推出**. |
| 知識庫 | Import an `oep-published-snapshot/1` JSON or gzip package, or choose a BI repository export folder. To enable model Q&A, check model consent on import, then bind the knowledge base in the assistant’s 知識庫 tab. The import list shows the publication version and source. Removal withdraws access and preserves publication history. |
| MCP | Add or import a custom connection, test it, and grant it to individual assistant workspaces. 設定 → 外部工具 links here. The built-in knowledge tool remains configurable under 設定 → 整合. |

For a local MXO stdio tool, enter the full path to `MXO_AI_MCP 1.exe`, select its working folder, and put `--transport` and `stdio` on separate lines. Choose the allowed projects, save, and choose **信任這個本機工具** before granting a workspace. Apply the existing runtime restart prompt to load its tools. A trusted executable’s Authenticode subject and certificate thumbprint are recorded when present, along with its signature status and SHA-256. Changes disable the connection and close its Windows Job. The card offers one-click re-trust and preserves the prior workspace grants. The same runtime restart applies the new catalog. The stdio child retains Windows network connectivity.

Skill projections live in the isolated OpenCode workspace of each assistant’s session. OEP applies exact Skill IDs at both the OpenCode permission layer and the gateway tool-call boundary. Instructions load on demand. Enabled assistants can read supported text resources through the existing controlled file tool. Script files from user-installed packages are retained as inert package files.

## Bundled Skills and licences

| Skill | Licence and attribution | Main assistant default |
|---|---|---|
| `hermes-test-driven-development` | MIT. Hermes Agent, adapted from obra/superpowers | On |
| `hermes-systematic-debugging` | MIT. Hermes Agent, adapted from obra/superpowers | On |
| `hermes-grounded-citations` | MIT. Hermes Agent and Teknium | On |
| `hermes-docx` | MIT. Nous Research | On |
| `hermes-xlsx` | MIT. Nous Research | On |
| `hermes-pdf` | MIT. Nous Research | On |
| `hermes-powerpoint` | MIT. Nous Research | On |
| `hermes-github` | MIT. Ben Barclay | On |
| `hermes-computer-use` | MIT. Francesco Bonacci and Hermes Agent | Off, per the desktop-tool decision |
| `oep-skill-creator` | MIT. OEP-authored guide based on AEP’s authoring flow | On |

The Hermes set comes from AEP commit `861d0c0ca0813073f3944d4aff88818980beff2a`. The bundle contains `SKILL.md`, available Markdown references and templates, and upstream licence text. The GitHub authentication reference has one credential-bearing example URL stripped. The rest of the Phase 3 defaults include company-only Skills or Skills that require AEP-specific services. Those remain outside the bundle. [Bundle notices](../../apps/adapter/default-skills/NOTICE.md) · [OpenCode Skill discovery and permissions](https://opencode.ai/docs/skills/)

## Test assertions

The existing disclosure keyboard assertions still exercise collapse and reload, with an added Tab check for the always-visible 能力 button. MCP selectors follow the moved controls. The Settings check now verifies the built-in tool and navigation link, and the capability-panel check covers the moved list and restart controls. The assistant wizard assertion now requires the instruction to enable Skills in Capabilities after creation. It replaces the old “Skills coming soon” assertion because the library is available. Schema version assertions require Web v13 and Knowledge v4, with the corresponding empty-table migration checks and original data reconciliation. The settings link uses plain language to satisfy the existing workbench text audit.

The Windows path probe sometimes hit its two-second process timeout during plugin tests on the shared workstation. A diagnostic run captured `ETIMEDOUT`. The helper retries that specific failure once and still requires a successful check before accepting the path. The existing safety assertions are unchanged.

The Plugin and BI Plugin browser setup still asserts that 能力 is enabled. It waits for the browser pairing indicator before clicking, since the enabled HTML button now appears before the module and API are ready. Installation and review assertions continue after the page opens.

## Verification

The Windows 11 run on 2026-11-23 used Node 24.14.1, a fresh temporary `OEP_DATA_DIR` for each command, and the verification Python venv only in test processes. The running owner installation and its data directory were outside the test scope. The temporary AEP checkout was removed from its working location after bundling.

The focused `npm run test:e2e:capabilities` suite passed 2 of 2 before the ordered gates. It verified Skill folder and ZIP installation, invalid metadata, per-assistant grants, native Skill text and resource delivery, uninstall, defaults, Workflow preview, published package and BI folder import, assistant binding, and cited Q&A. For MCP it verified an executable path with spaces, `--transport stdio`, Authenticode and file hashing, a workspace-scoped grant, a TCP request from the stdio child, revocation after a simulated fingerprint change, and re-trust.

| Ordered gate | Recorded result |
|---|---|
| `npm run lint` | Passed. Checked 389 source and configuration files. |
| `npm run typecheck` | Passed. `tsc --noEmit` exited 0. |
| `npm test` | 122 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Passed. Built `OEP-0.0.0-windows-x64.zip` and passed the archive scan. |
| `npm run test:e2e:browser` run 1 | Passed in 193.8 s. Two languages, two themes, narrow keyboard and Plugin picker/drop coverage. Supervisor exit 0, child exit 0, orphans 0. |
| `npm run test:e2e:browser` run 2 | Passed in 189.0 s in a fresh data root. Supervisor exit 0, child exit 0, orphans 0. |
| `npm run test:e2e:knowledge` | 1 passed. Chromium imported a repository and showed citations. OpenCode MCP returned both verified and rejected results. |
| `npm run test:plugins` | 9 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:bi-plugin` | 1 synthetic test passed. The optional owner repository test skipped because `OEP_MARKET_INTEL_DIR` was unavailable. |
| `npm run test:contract:native:isolation` | 5 passed, 0 failed. OpenCode 2.3.2, supervisor exit 0, child exit 0, orphans 0. |
| `npm run test:release:determinism` | 1 passed. Both ZIP builds matched the release build SHA-256 below. |
| `npm run scan` | `{"mode":"tree","files":929,"hits":0,"rules":{}}` during the ordered run. |

The release archive SHA-256 is `7fabdc9748a3da7a21127f955044b93a7453070f0abeffaf0110c5e7f161b209`.

## Remaining work

- Phase 3E Workflow execution engine, including capability resolution, parameter and output validation, controlled test runs, approval, execution records and recovery.
- A controlled executor that can authorize packaged Skill scripts. Independent owner verification with live MXO hardware and service-executable identity for loopback HTTP MCP.
- The designed `.oepkb` interchange envelope. The demo imports OEP’s existing published JSON and gzip format.
- Reviewer gates `test:e2e:web`, Excel, installation, upgrade and backup.
