# Phase 4 Telegram and BI work validation

## Run locally

Use the normal Windows launcher and open **工作與排程**. Set the bot credentials only through the User-scope variables `OEP_TELEGRAM_MAIN_BOT_TOKEN` and `OEP_TELEGRAM_BI_BOT_TOKEN`. The allowlisted owner ID comes from `OEP_TELEGRAM_ALLOWED_USER_ID`. Restart the launcher after changing configuration. Either bot may start independently. Use distinct bots. The local ledger binds each bot slot to its bot identity and owner so replacing a bot or owner cannot forward previous deliveries. Use a separate OEP data directory for a different identity.

Start the private chat from Telegram. On Main, send a message or use `/ask <vault-id> <question>`. Conversation sessions are separated by topic and from Web conversations. Ask uses the existing vault model setting and citation verifier. On BI, send UTF-8 text, a file, or an approved HTTPS link. Use `/status` for the BI job totals. Publishing through the review UI creates a durable owner notification. Telegram intake itself never calls a model.

Under **BI Telegram 收件**, set the domain label and approved HTTPS origins. Use the status filter, select a source, and supply UTF-8 text if it needs a supplement. Each Telegram intake stages in its own vault under the assigned domain label. Public link fetches accept text and Markdown, use a bounded download, and deny redirects and nonpublic destinations. Binary PNG, JPEG, PDF and XLSX originals are retained for download and require a human text supplement. The review editor remains the place to check, approve and publish.

Use a Phase 3b BI candidate JSON in **每日排程**. Submit it immediately or save it for approval with an IANA zone and local time. Activate, pause, resume, remove, or run it from the work view. Run Now shares the current local day's occurrence key with the scheduled trigger. Reconciliation admits the latest eligible occurrence within 24 hours and records skipped or expired work. An ambiguous repeated local minute runs once. A nonexistent local minute has no occurrence. The window and lease recovery are checked at startup and while the launcher is running. Generic OpenCode Automation stays off.

## Reproduce

Run `npm run test:telegram` with Node 24. The tests run a loopback Telegram API and synthetic source data. They exercise overlapping update IDs, private-chat and sender rejection, denied link intake, file download, timeout after fake acceptance, explicit 429 with a five-second retry delay, and repeated delivery. A child exits during inbox admission, after commit before another offset request, after staging before replying, and with an in-flight outbox record. The recovered run reconciles 48 admitted updates, 24 BI effects after supplement, and one deliberately replayed publication and notification. The fake transport sees no duplicate sent payload or cross-bot response. The scheduler case checks one BI effect per occurrence after Run Now, restart, a fall-back fold and a multi-day clock jump.

Run `npm run test:e2e:knowledge` with the pinned Windows OpenCode executable, OpenAPI document and Chromium provisioned as for Phase 3. It checks the authenticated jobs surface, verifies a Telegram Ask citation using the synthetic Gateway, and exercises real OpenCode sessions for two synthetic Telegram topics.

## Recovery and limits

Stop the launcher before taking a consistent backup of the Web data directory, including `telegram.sqlite`, `telegram-chat.sqlite`, `knowledge.sqlite` and the OpenCode profile. Restore them together. To stop Telegram polling, stop the launcher and remove the relevant token from launch configuration. Once re-enabled against the same ledger, saved work resumes. After more than 24 hours offline, Telegram may have discarded updates that were never received.

A send that timed out, returned an ambiguous server error, or was interrupted after admission to the outbox remains **送達未確認**. Telegram provides no send idempotency key for retrying that outcome safely. Inspect the chat and the work status before sending a replacement. Explicit 429 responses honor Telegram's retry delay.

Real Main and BI smoke are **UNVERIFIED**. The optional Main smoke was skipped. The BI smoke requires the owner to provision its token. Real Windows sleep/wake, logout/login, RPO and RTO are **UNVERIFIED** under the O-3b waiver. Until the owner validates them in actual use, OEP provides no guarantee of scheduling correctness across real OS sleep or logout.
