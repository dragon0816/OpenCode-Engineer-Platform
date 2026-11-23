# Phase 3I subscription sign-in

Codex and Claude Code use subscription sign-in by default in **Settings → External Helpers → Manage sign-in** and in the assistant model sign-in dialog. **Advanced** contains the separately billed API-key options. OEP continues to require verified Windows isolation and the saved Claude Code terms confirmation.

## Owner setup on Windows 11 x64

1. Install the published standalone Windows CLI for each provider you use. Open a new PowerShell window and use `Get-Command codex.exe` or `Get-Command claude.exe` to locate the executable. Check its version with `--version` and calculate its lowercase SHA-256 with `(Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()`. Record the versions and hashes of the binaries you reviewed. [OpenAI Windows installer](https://github.com/openai/codex#installing-and-running-codex-cli) · [Anthropic Windows installer](https://code.claude.com/docs/en/quickstart#step-1-install-claude-code)
2. In 64-bit Windows PowerShell elevated as the same Windows user who runs OEP, run `scripts/windows/Setup-OEPExternalHelper.ps1` from this build. Pass the absolute executable path, three-part version, and lowercase SHA-256 for each provider. Follow the existing instructions for a custom OEP data directory. If 0.9.0 already provisioned the account and the provider pins are current, rerun the same script from this build to refresh the helper launcher. The script keeps the existing pins when you omit provider arguments. [Helper script arguments and setup details](PHASE3I_MODEL_SOURCES_REPORT.md#owner-setup-and-removal)
3. Open **Settings → External Helpers** and select **Recheck status**. Confirm the Claude Code terms if you use Claude Code. Select **Manage sign-in**, choose the ChatGPT or Claude subscription button, and select **Open sign-in page** when it appears. Complete authentication in your browser on the same Windows machine. If Claude displays a one-time code, submit it in the OEP dialog. For Codex device auth, enable device-code sign-in in ChatGPT security settings or workspace policy, choose the device-code option in OEP, and enter the displayed code on the OpenAI page. Confirm the CLI reports **Signed in** before using the model. **Sign out** runs the provider's CLI logout. [ChatGPT authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices) · [Claude Code login troubleshooting](https://code.claude.com/docs/en/troubleshoot-install#oauth-login-fails-in-wsl2-ssh-or-containers)

## CLI and credential handling

- Codex runs `codex login`, `codex login --device-auth`, `codex login status`, and `codex logout`. API-key sign-in still uses `--with-api-key` with stdin. The adapter accepts ChatGPT and API-key status and tests the stderr format used by the current CLI. Codex status reports the authentication mode when local credentials are present. OEP uses expiry or reauthentication information when the CLI supplies it. [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login) · [Codex status source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/login.rs) · [Codex device prompt source](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)
- Claude runs `claude auth login` with subscription defaults, `claude auth status` (JSON by default), and `claude auth logout`. The status projection includes the account's email when the CLI supplies it. The documented stdin fallback accepts a browser-issued authorization code. `claude setup-token` prints a reusable OAuth token and requires the caller to store or set it, so this implementation uses browser OAuth to let the CLI manage the credential. The saved terms confirmation still applies to running the owner's published CLI. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference#cli-commands) · [Claude authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) · [Anthropic terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- The read-only AEP reference at commit `1e351469` was `packages/hermes-skill-pack/skills/vendor/hermes-codex/SKILL.md` and `packages/hermes-skill-pack/skills/vendor/hermes-claude-code/SKILL.md`. OEP follows the standalone CLI flows and leaves the subscription credentials under `OEPExternalHelper`.
- The existing alternate logon, profile, ACL probes, executable pin and kill-on-close Windows Job still guard sign-in, status and logout. The CLI owns the loopback callback. The adapter relays only validated vendor authorization links, displayed device codes and a prompt to paste a one-time code. Pasted codes travel over stdin. Paired browser sessions can only access their own pending exchange. The adapter drops the exchange on completion, cancellation, browser disconnect or timeout. An older helper bootstrap returns a localized prompt to rerun setup.
- The adapter does not open the CLI credential store. It discards other login output and exposes only normalized status and optional account metadata. It keeps exchange data in memory and serves it with `Cache-Control: no-store`. The earlier paired API call without an exchange still supports its legacy interactive console behavior.

## Verification coverage and assertion changes

- The fake Windows supervisor spawns fake CLIs for a loopback callback, device-code approval, pasted-code stdin, status JSON and text, logout, failure, timeout, cancellation and browser disconnect. It simulates an outdated bootstrap. The test rejects wrong-browser access and malformed codes. It injects synthetic credential material into fake CLI output and checks response bodies, captured logging inputs and every file in the temporary OEP data root for both that material and the submitted one-time code.
- Chromium retains the warning, signed-out and focus restoration assertions for the model-entry dialog. The assertions for the previous authentication dropdown and End-key selection were replaced because the dropdown was removed. The new assertions check subscription as the focused primary action, a collapsed Advanced section, keyboard opening and password-masked key entry. Added coverage includes helper setup guidance, Traditional Chinese device-code entry and copying, English Claude code submission, account display, logout and cancellation. The clipboard test uses an in-page stub.
- The first targeted fake-process run timed out waiting for the browser prompt because the Windows Node fixture paused stdin and kept its pipe open on completion. The fixture now closes the pipe at completion. The same contract passed after the fix. The first TypeScript probe found a missing discriminant in the request validator. The validator now returns distinct variants. No other existing assertions were removed or loosened.
- The first full Chromium run caught the ASCII script path in a Traditional Chinese UI message. The path is now rendered as code next to the localized instructions. The language assertion remains in place.

## Release gates

Windows 11 x64, Node 24.14.1, implementation `7fd75f7`. `npm ci` added 16 packages. The Phase 0 assets and source came from the main checkout. The hook installer refused the inherited snapshot path. After verifying the three inherited hooks matched the workspace copies, the installer completed with `.githooks` configured for this worktree. Each gate used a fresh temporary `OEP_DATA_DIR` and process-local `oep-verify-venv` Python.

The pinned OpenCode archive and OpenAPI source matched the release SHA-256 pins and were copied into this worktree's release cache. A failed release diagnostic localized the error to the existing Windows file probe during BI plugin packaging. The unchanged release command passed on retry.

The existing restricted-token external-helper fixture calls `icacls /setintegritylevel` on its test directories. To honor the no-ACL-changes constraint, the external-helper command ran with a name filter for its two ACL-free cases. The restricted-token case and its assertions remain in the suite for review.

| Command | Exit | Observed result | Seconds |
| --- | ---: | --- | ---: |
| `npm run lint` | 0 | 382 source and configuration files checked | 1.35 |
| `npm run typecheck` | 0 | TypeScript completed | 6.32 |
| `npm test` | 0 | 123 passed, 0 failed, 0 skipped | 30.52 |
| `npm run build:release` | 1 | Windows file probe during packaging | 3.00 |
| `npm run build:release` retry | 0 | Windows x64 ZIP built and scanned | 24.16 |
| `npm run test:e2e:browser` run 1 | 0 | Chromium passed, 0 orphans | 164.55 |
| `npm run test:e2e:browser` run 2 | 0 | Chromium passed, 0 orphans | 173.50 |
| `npm run test:e2e:external-helpers` with ACL-free name filter | 0 | Two tests passed. The restricted-token case was outside this run. | 6.17 |
| `npm run test:e2e:delegation` | 0 | Four tests passed, 0 orphans in both OpenCode jobs | 74.34 |
| `npm run test:release:determinism` | 0 | Two byte-identical release ZIPs | 48.09 |
| `npm run scan` | 0 | 880 files, 0 hits | 1.71 |

The release ZIP SHA-256 is `72fb827ece5dda7bfb17185cc3d1d861feeddc0d062fedbabff1941e4fb3590d`. Eight changed login, launcher and localization files matched the archive byte for byte.

Owner review still covers actual sign-in, status, logout and loopback or code compatibility using the published provider CLIs and a genuine alternate Windows logon. The reviewer also owns the restricted-token external-helper case and the dedicated Web HTTP, Excel, install, upgrade and backup gates. This run used fake provider CLIs, created no Windows accounts, changed no ACLs, and left the installed OEP and its data untouched.
