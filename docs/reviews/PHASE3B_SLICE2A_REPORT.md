# Phase 3B slice 2a session scopes and tool authorization

2026-11-22 · `phase-3b/slice-2a-scopes` · main base `696997e` · merged native probe `6ee8616` · Windows 11 x64, Node 24.14.1, PowerShell 7.6.10.

## Delivered

- The OpenCode relay requires SSE for managed tool requests. It rejects non-streaming requests that carry tool definitions before contacting the gateway. A streaming request whose upstream response has a different media type returns a fixed error. Server-side Knowledge and BI callers retain JSON completions on their separate relay.
- Web and Telegram Main get their execution configuration from session ownership and the active agent and workspace in the slice 1 ledger. Session creation validates the native template, directory, relay provider, and approved model. Dispatch rechecks persisted ownership and the native profile, uses the current agent instructions and revision, and replaces the complete permission set. Custom MCP grants require both the applied registration and the current ledger grants. A revoked grant invalidates subsequent model tool calls and triggers turn cancellation.
- The same deny-by-default builder supplies every managed turn, including Workbook. Workbook still gets its transitional native `edit` rule for exactly `generated/<run-id>.json` in its existing session workspace. The rule is removed at the end of the turn by restoring a complete permission set. OpenCode still resolves permission requests, and OEP rejects additional requests during reconciliation.
- The loopback broker checks Host, Origin, content type, request size, method and a per-launch credential. Only `oep_status` is registered on it. Each attempt uses a random nonce in the current user-message suffix. The relay matches that suffix and the approved model against the live turn and removes transport metadata from the model request. It checks completed SSE tool calls against the advertised allowlist before injecting a broker ticket. The ticket is bound in memory to the launch, upstream session, run, tool, call ID and normalized argument hash. It expires after 15 seconds on a monotonic clock. The broker checks the live scope and consumes the ticket once. Status accepts an empty argument object and returns the agent and workspace display names. Turn completion, abort and runtime stop revoke tickets. The Web projection and status-only OEP audit records exclude the nonce and ticket.
- `OEP_SYNTHETIC_STATUS_TOOL=0` opts out of the status tool in source-based synthetic tests. The default enables it only for a profiled runtime with an isolated Job and an injected synthetic gateway fetch. The production launcher and packaged builds leave the broker and status tool disabled, regardless of the environment value.
- One FIFO model seat per runtime covers Web, Telegram Main, and the direct model requests used by BI proposal and Knowledge entry points. The existing Knowledge MCP call uses the parent OpenCode turn's lease and serializes its nested model calls. Web and Telegram keep their existing submission, delivery and audit paths.

## Deviations and scope limits

No slice 2a design deviations required a decision-log entry. The scoped dispatcher covers the existing Web and Telegram Main session origins. The permission builder starts closed for future schedule and delegation turns. Legacy Knowledge and custom MCP calls still use their existing transports. Their current grants are checked at dispatch and at the relay, and a revocation requests native interruption. Authorization at the moment the tool listener receives a call applies to the ticketed status tool in this slice.

## Test changes

- `tests/e2e/isolation-gate.test.ts` keeps the pinned SSE positive case, hidden-tool denial, permission precedence and replacement, and Web projection assertions. The direct JSON-to-OpenCode case previously asserted tool delivery and treated the observation deadline as evidence against the positive. Section 12 supersedes that case. Its replacement checks successful SSE delivery from the production relay, rejection of a JSON upstream response on a stream request, and rejection before forwarding for tool requests with `stream` false, missing, string, number or null. A new pinned run covers the production status broker, model-supplied transport-field rejection, metadata scrubbing, and Web → Telegram Main → BI model-seat order. The BI check uses the same production `knowledge.propose` model entry as Telegram BI.
- `tests/e2e/synthetic-completion.ts` adds the SSE media type to synthetic streamed responses so they satisfy the same wire contract as the production upstream. Existing response bodies and assertions are intact.
- `tests/contract/permissions.test.ts` replaces the inspector assertion that every rule was `read` with an exact assertion for the new leading deny and the two original file grants. It retains the exact native Workbook probe write rule and adds scope checks for Web, channel, schedule, delegation and specialist permissions.
- `tests/contract/gateway-models.test.ts` extends the native API double to return the persisted session profile and accept full permission replacement. The existing assertions on model rejection, fallback, switch failure, durable admission and call order remain in place.
- `tests/e2e/custom-mcp.ts` seeds the same synthetic definitions in the SQLite ledger before launch. The project and per-tool visibility assertions now exercise the intersection of ledger grants and registered definitions, with their original expectations intact.
- `tests/contract/tool-tickets.test.ts` adds forged and replayed token rejection, tool and call mismatch, forbidden argument fields, expiry, late use, scope switch, abort, restart and transport scrubbing checks. `tests/contract/model-seat.test.ts` adds FIFO coverage through cancellation and provider failure.

## Sequential verification

Each command used a fresh temporary `OEP_DATA_DIR` and process-local Python configuration from `oep-verify-venv/Scripts`. The first sequence stopped at `npm test` when the upgrade fixture detected an accidental dependency on the Workbook converter. The fix kept the output-path policy independent of the converter. Verification restarted at lint with all source files tracked.

| Gate | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 in 0.92 s. Checked 232 source and configuration files. |
| `npm run typecheck` | Exit 0 in 4.73 s. No diagnostics. |
| `npm test` | Exit 0 in 7.91 s. 81 passed, 0 failed, 0 skipped. |
| `npm run build:release` | Exit 0 in 43.57 s. Release scan passed. `OEP-0.0.0-windows-x64.zip` SHA-256 `fff3ed588c5aaa801e6a2a4be5e556300ba142c6cca5f1edc77187f4e4a4dae4`. |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 66.56 s. `supervisorExit=0`, `childExit=0`, `orphans=0`. |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 68.52 s. `supervisorExit=0`, `childExit=0`, `orphans=0`. |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 68.47 s. `supervisorExit=0`, `childExit=0`, `orphans=0`. |
| `npm run test:e2e:knowledge` | Exit 0 in 24.72 s. 1 passed, 0 failed, 0 skipped. |
| `npm run test:ingest` | Exit 0 in 3.93 s. 16 passed, 0 failed, 0 skipped. |
| `npm run test:telegram` | Exit 0 in 1.82 s. 5 passed, 0 failed, 0 skipped. |
| `npm run test:e2e:mcp` | Exit 0 in 52.11 s. Isolated MCP probes passed with verified Job cleanup. |
| `npm run test:compliance` | Exit 0 in 0.39 s. 2 passed, 0 failed, 0 skipped. |
| `npm run test:release:determinism` | Exit 0 in 36.83 s. 1 passed, 0 failed, 0 skipped. Both builds reproduced the release SHA-256 above. |
| `npm run test:contract:native:isolation` | Exit 0 in 10.83 s. 5 passed, 0 failed, 0 skipped. Both pinned OpenCode jobs reported `supervisorExit=0`, `childExit=0`, `orphans=0`. |
| `npm run scan` | Exit 0 in 1.12 s. 552 files, 0 hits. |

## Remaining in slice 2b

- Add controlled file reads and atomic, handle-verified writes. Replace the transitional Workbook rule with the brokered file tool and verify the generated XLSX.
- Apply agent and workspace knowledge bindings, publication and evidence rules to Web, Telegram `/ask` and MCP.
- Broker eligible remote HTTPS MCP tools and implement the approved pause for local and private-network MCPs. Verify cross-agent, cross-session and Windows path boundaries.
- Add the design §3.2 isolation benchmark harness and run its smoke check.

## Left for reviewer

`test:e2e:web`, `test:e2e:excel`, `test:install`, `test:upgrade`, and `test:backup`. The owner’s running OEP, installation directory, and data directory were outside the test setup.
