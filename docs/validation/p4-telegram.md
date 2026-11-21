# Phase 4 Telegram and BI work validation

## Run locally

Use the normal Windows launcher and open **工作與排程**. Set the bot credentials only through the User-scope variables `OEP_TELEGRAM_MAIN_BOT_TOKEN` and `OEP_TELEGRAM_BI_BOT_TOKEN`. The allowlisted owner ID comes from `OEP_TELEGRAM_ALLOWED_USER_ID`. Restart the launcher after changing configuration. Either bot may start independently. Use distinct bots. The local ledger binds each bot slot to its bot identity and owner so replacing a bot or owner cannot forward previous deliveries. Use a separate OEP data directory for a different identity.

Start the private chat from Telegram. On Main, send a message or use `/ask <vault-id> <question>`. Conversation sessions are separated by topic and from Web conversations. Ask uses the existing vault model setting and citation verifier. On BI, send UTF-8 text, a file, or an approved HTTPS link. Use `/status` for the BI job totals. Publishing through the review UI creates a durable owner notification. Standalone intake keeps source content local.

Under **BI Telegram 收件**, set the domain label and approved HTTPS origins. Use the status filter, select a source, and supply UTF-8 text if it needs a supplement. Leaving the target blank selects **獨立收件**, which stages each source in its own vault. Setting an existing active BI vault with a review schema authorizes the model-assisted proposal flow for that target. UTF-8 source text goes to the configured model under the existing proposal size limit. Exact quotes are checked against the source before a pending change set is created. A missing quote or unavailable model leaves the source blocked with a supplement option. A human checks, approves and publishes the change set.

Public link fetches accept text and Markdown, use a bounded download, and deny redirects and nonpublic destinations. Binary PNG, JPEG, PDF and XLSX originals are retained for download and require a human text supplement. Stored source bytes in `bi_sources` have no retention limit.

Use a Phase 3b BI candidate JSON in **每日排程**. Submit it immediately or save it for approval with an IANA zone and local time. Activate, pause, resume, remove, or run it from the work view. Run Now shares the current local day's occurrence key with the scheduled trigger. Reconciliation admits the latest eligible occurrence within 24 hours and records skipped or expired work. An ambiguous repeated local minute runs once. A nonexistent local minute has no occurrence. The window and lease recovery are checked at startup and while the launcher is running. Generic OpenCode Automation stays off.

## Reproduce

Run `npm run test:telegram` with Node 24. The tests run a loopback Telegram API and synthetic source data. They exercise overlapping update IDs, private-chat and sender rejection, denied link intake, file download, timeout after fake acceptance, explicit 429 with a five-second retry delay, and repeated delivery. A child exits during inbox admission, after commit before another offset request, after staging before replying, and with an in-flight outbox record. The recovered run reconciles 48 admitted updates, 24 BI effects after supplement, and one deliberately replayed publication and notification. The fake transport sees no duplicate sent payload or cross-bot response. The scheduler case checks one BI effect per occurrence after Run Now, restart, a fall-back fold and a multi-day clock jump.

Run `npm run test:e2e:knowledge` with the pinned Windows OpenCode executable, OpenAPI document and Chromium provisioned as for Phase 3. It checks the authenticated jobs surface, verifies a Telegram Ask citation using the synthetic Gateway, and exercises real OpenCode sessions for two synthetic Telegram topics.

## Recovery and limits

Stop the launcher before taking a consistent backup of the Web data directory, including `telegram.sqlite`, `telegram-chat.sqlite`, `knowledge.sqlite` and the OpenCode profile. Restore them together. To stop Telegram polling, stop the launcher and remove the relevant token from launch configuration. Once re-enabled against the same ledger, saved work resumes. After more than 24 hours offline, Telegram may have discarded updates that were never received.

Each bot uses one 25-second Telegram long poll with a 35-second request timeout. Shutdown aborts the outstanding poll. The bot can process saved work and deliver replies while waiting for updates. Explicit 429 responses honor Telegram's retry delay.

An inbox row records when it was first seen, its first processing attempt and its attempt count. Main chat has 120 seconds from its first processing attempt, including time spent across a restart. The same budget applies to other updates. Processing retries at intervals of at least six seconds and stops after 20 attempts or when the time budget expires, whichever comes first. A failed row retains its original payload and appears in **工作狀態**. Its Traditional Chinese failure reply is created once in the outbox. Within each topic, ordinary updates run in order and commands run in their own ordered lane. `/ask` and `/status` can pass a stalled ordinary update. If a failed Main intake still has an unresolved turn, the next chat turn opens a fresh session and the old run remains available in the local ledger.

A send that timed out, returned an ambiguous server error, or was interrupted after admission to the outbox remains **送達未確認**. If it did not reach Telegram, it stays undelivered until the owner acts. Inspect the chat first, then use **手動重送** in the unresolved-delivery list to requeue it. The confirmation warns that the original may already have arrived and a resend may create a duplicate. Telegram provides no send idempotency key.

Real Main and BI smoke are **UNVERIFIED**. The optional Main smoke was skipped. The BI smoke requires the owner to provision its token. Real Windows sleep/wake, logout/login, RPO and RTO are **UNVERIFIED** under the O-3b waiver. Until the owner validates them in actual use, OEP provides no guarantee of scheduling correctness across real OS sleep or logout.
