# Phase 3B slice 2 isolation transport gate

2026-11-22 · `phase-3b/slice-2-isolation` · base `81c4ae8` · Windows 11 x64, Node 24.14.1, PowerShell 7.6.10.

## Contract-gate outcome

**Blocked at the JSON completion requirement.** The Windows v2.3.2 binary requested `stream: true`. The synthetic relay inserted its field into a complete tool-call argument object and sent a valid non-streaming `application/json` completion on that connection. The native turn reached the observation deadline with zero MCP calls. The pinned OpenAI-compatible provider reuses the OpenAI Chat protocol, which fixes the request to streaming and uses SSE framing. [Pinned provider route](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/ai/src/protocols/openai-compatible-chat.ts#L15-L20) · [Streaming request](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/ai/src/protocols/openai-chat.ts#L896-L908) · [SSE framing](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/ai/src/protocols/openai-chat.ts#L1405-L1412)

In OEP, the relay selects its completion parser from the request's `stream` flag. Knowledge and BI already exercise the JSON parser through a direct server-side caller using `stream: false`. The native probe delivered JSON from its dedicated relay to exercise OpenCode's decoder independently of the production relay's parser selection. [Relay](../../apps/adapter/src/opencode/gateway.ts) · [Direct knowledge model client](../../apps/adapter/src/opencode/knowledge-model.ts)

The SSE positive case reassembled split tool arguments, inserted the fixture field, and observed the exact argument object at the MCP listener. The native schema contained the required field. The model-facing fixture view and the real `ChatService.state()` projection hid the nonce and transport field, including at the next provider request after the tool call. An unadvertised MCP tool supplied by the synthetic model was rejected by the probe relay before receiving a tool call.

The native checks also verified later matching permission rules take precedence and a full `session.update()` replaces a prior allow. The synthetic denied permission set covered shell, web fetch, task, native read/edit and external directory actions. The test used the supervisor's isolated Windows Job and synthetic loopback listeners. Job cleanup reported `supervisorExit=0`, `childExit=0` and `orphans=0`.

## Delivery and deviations

The branch delivers the test-only native probe and this record. The approved §3.2 stop condition applies. The scoped tool path is disabled and the branch contains no production runtime changes. The test used a stand-in transport value to exercise the protocol. Production tickets, authorization and replay protection still require implementation.

There are no deviations from the approved stop condition. `DECISIONS.md` has no new entry. The JSON case deliberately fails its positive assertion so this command cannot report that the pinned contract passed.

## Test changes

- `tests/e2e/isolation-gate.test.ts` adds SSE, JSON and hidden-tool cases to isolate the relay-to-native boundary. The cases use the hashed binary and client verified by the existing supervisor, OpenCode sessions, a synthetic MCP schema and the real Web state projector. The test's listener has no file or knowledge capabilities.
- `package.json` adds `npm run test:contract:native:isolation` so the gate runs independently of the legacy suite and uses an isolated Job. Existing tests and assertions were retained.

## Remaining work

- Resolve the native completion contract in design review. The current probe tests sending JSON directly to the pinned provider client. A contract that normalizes JSON to SSE before delivering it to OpenCode would require a reviewed design and a proof for both upstream formats.
- Implement session configuration from current agent, workspace, origin, model, instructions and revision. Apply the full permissions and model checks at dispatch and migrate Workbook off native writes.
- Implement the built-in MCP broker, one-time scoped tickets, lifecycle invalidation, revocation and reconciliation. Add tests for forgery, replay, expiry, late calls, scope changes and revoked grants.
- Implement controlled reads and handle-verified atomic writes with cross-agent, cross-session and Windows path and link tests. Verify a workbook produced through the broker as XLSX.
- Apply knowledge bindings and publication rules to Web, Telegram `/ask` and MCP. Add unbound-vault and draft coverage. Pause stdio and private-network MCPs for assistants and route eligible remote HTTPS tools through the broker.
- Share the model seat between Web, Telegram Main and BI. Add the §3.2 benchmark harness and run its short smoke check once the scoped components exist.

## Sequential verification

Each command used a fresh temporary `OEP_DATA_DIR` outside the owner data root. The verification venv was first on `PATH` and supplied process-local `OEP_PYTHON`. The first pass found a test fixture URL type mismatch. After the correction, the ordered sequence was repeated from lint through the native gate.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.90 s. Checked 223 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.91 s. `tsc --noEmit` completed without diagnostics. |
| `npm test` | Exit 0 in 7.81 s. 76 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 16.66 s. Release scan passed. `OEP-0.0.0-windows-x64.zip` SHA-256 `42346f3db16c7d063a59d5b48f79600149618345e0c25185562ae0ce108dcb9a`. |
| `npm run test:e2e:browser` | Three exit-0 runs in 67.18, 67.39 and 68.96 s. Each reported `supervisorExit=0`, `childExit=0` and `orphans=0`. |
| `npm run test:e2e:knowledge` | Exit 0 in 24.87 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 4.04 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 1.87 s. 5 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 51.86 s. `Isolated MCP probes passed with verified Job cleanup.` |
| `npm run test:compliance` | Exit 0 in 0.39 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 36.18 s. 1 passed, 0 failed, 0 skipped. Both release builds matched the hash above. |
| `npm run scan` | Exit 0 in 1.12 s. 542 files, 0 hits. |
| `npm run test:contract:native:isolation` | Exit 1 in 20.87 s. SSE and denied cases passed. JSON and its parent suite failed. OpenCode requested `stream=true` and reached the observation deadline without invoking MCP after the JSON completion. Job cleanup was verified. |

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade` and `test:backup` were reserved for reviewer execution. The running OEP and its installed and data directories were left untouched.
