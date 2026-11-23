# Phase 3 remote MCP OAuth

Branch `phase-3/mcp-oauth`, based on `20d93ae`. Windows 11 with Node 24.14.1. Verification uses synthetic endpoints and accounts.

## Implementation

- OEP reads the `Bearer` challenge and protected-resource metadata, with path and root well-known fallback. It then checks OAuth authorization-server metadata or OIDC discovery, validates the resource and issuer, and requires PKCE `S256`. The browser authorizes a code bound to the specific MCP resource. The single-use random `127.0.0.1` callback port validates `state` and advertised `iss` before exchange. OAuth supports pre-registered clients and native dynamic client registration. OEP selects the existing bound issuer when available and otherwise uses the first advertised issuer. [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) · [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) · [Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) · [RFC 8252 loopback redirects](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)
- The pre-registered client ID and optional secret use the existing Windows User-scope credential mechanism. Issuer binding stays with those credentials. Access and refresh tokens use a DPAPI `CurrentUser` file under `web/mcp-oauth` in the OEP data root. DPAPI provides encryption for the Windows account and keeps rotating tokens out of the Windows environment and SQLite. Token records are replaced atomically and excluded from backup snapshots. A backup can contain server settings and the Windows credential reference name. [DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope)
- OAuth and MCP server requests use pinned IPv4 TLS connections and refuse redirects. The user's browser handles the consent navigation. The broker sends the bearer token only to the configured MCP resource, refreshes expired tokens, and retries once after a 401. Sign-out clears the local tokens and calls the advertised revocation endpoint. OEP shows a provider-account instruction when remote revocation is unavailable or fails. Changing the server URL, scopes, or client requires a fresh grant. Review the provider's consent screen for any scopes that it requests in addition to the scopes entered in OEP.
- Assistants use the existing ticketed broker and its agent, workspace, project, and per-tool checks. OAuth supports stateless `2026-07-28` Streamable HTTP with a fallback to the earlier handshake for servers that require it. Some names are represented by short aliases for Gateway compatibility. Settings and deny lists use the server's original names, which the broker forwards unchanged. The local OpenCode config still points to the OEP broker. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- **External tools** offers None, API key headers, and OAuth sign-in. Save the entry to show sign-in and sign-out on its card. Test connection after sign-in to see the tools. Apply the updated runtime settings when prompted. **Import configuration** accepts one OpenCode-style remote definition and prefills the form. `{env:NAME}` in a credential value displays a hint and leaves the field blank.

## Connect Gmail MCP

1. Confirm your Google account can use the Gmail MCP Developer Preview. For one account, open Google's personal setup and choose the **Desktop app** client type. Select or create a Google Cloud project and choose the Gmail scope. For a managed project, enable both **Gmail API** and **Gmail MCP API**, configure Google Auth Platform consent and audience, then create a **Desktop app** OAuth client. If the app is External and in Testing, add the account as a test user. [Google Gmail MCP setup](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
2. Verify **Use this client for an AI-powered agent** in Google Auth Platform → Clients. Copy the client ID and secret. A Desktop app client supports the `127.0.0.1` redirect with a port chosen at sign-in. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app#redirect-uri_loopback)
3. In OEP, go to **Settings → External Tools → Add server**. Choose **Remote service**, enter `https://gmailmcp.googleapis.com/mcp/v1`, select **OAuth sign-in**, and choose **Enter my client details**. Enter the Google client ID and secret. Use `https://www.googleapis.com/auth/gmail.readonly` for reading mail and check the tool reference before granting permissions for labeling or drafting. Choose the applicable project and describe the data the tool can access. [Gmail MCP tools and required scopes](https://developers.google.com/workspace/gmail/api/reference/mcp)
4. Save, then select **Sign in** on the server card. In the browser, verify the Google account and permissions before approving. Return to OEP after the callback confirms sign-in.
5. Use **Test connection** to list tools. Disable tools the assistant should not use. Restart the runtime if prompted, then verify the intended assistant and workspace have the server capability. Test with a read-only request in a new session.
6. To disconnect, use **Sign out** on the server card. If the provider's grant is still active, remove the corresponding connection in Google Account settings. [Google Account third-party connections](https://myaccount.google.com/connections)

### Data that leaves the machine

- During sign-in the system browser sends the client identifier, requested resource and scopes, PKCE challenge, and redirect details to the provider. The authorization server receives the code and verifier for exchange and the client secret when the registered client uses one. It receives the refresh token for renewal or revocation. OEP settings responses and model context omit these credentials.
- The MCP server receives the bearer access token, tool name, and arguments. Tool arguments can include user or model text. Returned data, such as email subjects, threads or snippets, can enter OEP conversation history and be processed by the company's self-hosted LLM Gateway. The OAuth connection does not extend the public-only policy for external coding agents.

## Synthetic verification

- HTTPS fixture coverage includes challenge and well-known discovery, issuer and state rejection, PKCE, static client authentication, DCR, expiry, 401 retry, `invalid_grant`, scope change, sign-out and revocation, and redirect refusal. Both modern and handshake-era MCP paths use the test CA.
- Isolated Chromium exercises OAuth in Traditional Chinese and English at 390 px, uses the keyboard to import and sign in, checks placeholder handling and masked inputs, and lists tools after sign-in. The Windows default-browser handoff is intercepted so the test opens consent in an isolated Chromium profile.
- The pinned OpenCode test checks exact remote tool forwarding, the readable insufficient-scope error, and denials for a wrong project, missing workspace grant, missing agent grant, and a denied tool. The fixture uses the synthetic pinned transport to target loopback because production pauses private-network MCP on the assistant path. It checks effective OpenCode configuration, synthetic SQLite, logs, runtime files, and UI/API/model outputs for credential markers.
- Existing assertions are preserved. The Traditional Chinese UI vocabulary check permits the exact terms `OAuth`, `API key`, and `ID` on the external-tool screens because those are the authentication choices and credential field names the owner needs to match against the provider UI.

## Gate results

The worktree used `npm ci`, the pinned `.phase0` assets and source from main, and the repository hooks. The worktree initially inherited a hook snapshot from the main checkout. Setting the worktree's hook path to `.githooks` allowed the hook installer to complete. Every gate used a fresh `OEP_DATA_DIR` and process-local Python from `oep-verify-venv`. OAuth credential writes in tests used the test abstraction. The running OEP installation and data directories were outside the test setup.

Two focused OAuth runs reached the Chromium fixture and stopped at simulated Enter activation. The fixture switched to the existing Chromium Space-key dispatch and retained the focus and keyboard assertions. The next focused run passed. The first full sequence stopped at `npm test` because seven OAuth message keys were used dynamically and the i18n checker expected literal references. Those references were changed. The second sequence passed through the release build and stopped at the first browser run because the temporary root itself contained the technical term `mcp`. The sequence was restarted using neutral temporary-directory names, with the text assertion intact.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 1.17 s. Checked 289 source and configuration files. |
| `npm run typecheck` | Exit 0 in 5.79 s. |
| `npm test` | Exit 0 in 16.96 s. 104 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 19.71 s. Release scan passed. SHA-256 `d647b3e99552041b6a594cd51413a1fc94fcd5fe0a0953e0e5ab64ec7fefb65a`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 131.38 s. Supervisor and child exit 0, 0 orphans. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 132.26 s. Supervisor and child exit 0, 0 orphans. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 131.05 s. Supervisor and child exit 0, 0 orphans. |
| `npm run test:e2e:mcp` | Exit 0 in 78.56 s. Broker policy, isolated probes, HTTPS, Chromium, and OAuth fixtures all passed. |
| `npm run test:contract:native:isolation` | Exit 0 in 25.65 s. 5 passed, 0 failed, 0 skipped. OpenCode 2.3.2, 0 orphans. |
| `npm run test:e2e:delegation` | Exit 0 in 68.48 s. 4 passed, 0 failed, 0 skipped. OpenCode 2.3.2, 0 orphans. |
| `npm run test:release:determinism` | Exit 0 in 35.38 s. 1 passed. Both ZIPs reproduced the release SHA-256. |
| `npm run scan` | Exit 0 in 1.59 s. 744 files scanned, 0 hits. |

## Review items

- Reviewer gates are `test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`.
- Provider interoperability and the actual Windows default-browser handoff await owner verification. The settings card shows sign-in status without an account name. OEP uses the service's bearer tokens and skips separate identity scopes and ID-token processing. Client ID Metadata Documents and interactive tool confirmation are outside this slice. [MCP registration options](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
