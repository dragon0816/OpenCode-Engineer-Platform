# OEP 0.7.0 benchmark JSON upload

Branch `fix/paste-json-upload`, based on `0084e2a`. Tested on Windows 11 with Microsoft Edge 157.0.4341.60 in headless Chromium mode, Node 24.14.1, and the isolated verification Python environment.

## Reproduction and root cause

The failure reproduced when an existing main-assistant session had lost its empty attachment directory. OEP's file-only backup and restore preserve the SQLite session row and only create destination directories that contain a copied file. A direct run of `scripts/windows/data-snapshot.mjs copy` against a synthetic SQLite row and an empty `web/sessions/<id>/attachments` verified that both the empty session directory and its attachment subdirectory were omitted. Startup creates the shared `sessions` directory. The upload previously assumed each session's attachment subdirectory already existed.

1. On the original code, the route returned `201` for both filenames with both wire MIME types when storage existed. The two supplied downloads were valid UTF-8 JSON arrays of 368 bytes. The final fixture uses the same row shape and 354 bytes of synthetic data.
2. With the session row retained and its empty directory omitted, the identical route request returned `503 unavailable`. On Windows, `AttachmentService.upload` called `checkDirectory` before staging. The Windows attribute probe rejected the missing path, and the plain error reached the adapter's generic response.
3. The red Chromium test pasted an empty-MIME `File` named `oep-benchmark (79).json` into that session. It observed `oep-benchmark (79).json · OEP 無法完成操作。請稍後再試。` and zero selected attachments. The existing composer checks, including ordinary JSON upload and preview, had passed earlier in the run.

Paste, drop and the attachment button share the same upload route. Empty browser MIME is sent as `application/octet-stream`. The route accepts that and `application/json` for JSON filenames and validates the payload as UTF-8 text. The encoded filename header round-trips spaces, parentheses and CJK. Only workbooks use a projection. The failing request reaches the directory check before the attachment and its source classification are committed. The preexisting pending slot releases in `finally`, and repeated failure followed by success now has a route assertion.

The test establishes a root cause for the reproduced failure. The live 0.7.0 session's directory state remains unverified.

## Fix and diagnostics

- Recreate missing session and attachment directories on the first validated upload. On Windows, the existing native worker creates each missing child relative to a verified parent handle. Existing directories still undergo the normal directory validation. A blocked path stays intact.
- Record a fixed code, timestamp and event in `web-uploads.jsonl` under the current runtime audit directory. Where applicable, the response distinguishes an incomplete request, busy storage, exhausted storage and inaccessible storage. An unrecognized server exception keeps the generic banner and records `upload-unexpected`.
- Read the bounded browser file before sending so an inaccessible local file gets a dedicated message. The browser reports fixed diagnostic codes through an authenticated, CSRF-protected route when it can reach the adapter. Audit records exclude filenames, paths, contents, and raw exception details. If the audit writer fails, it emits the same fixed record to stderr.

## Coverage

- Chromium covers paste, drop and the attachment button for both filenames and both MIME types. It also selects disk-backed fixtures through Chromium's picker, injects known and unexpected browser read failures, checks localized feedback and audit records, and verifies retry.
- The HTTP contract checks filename round-tripping, stored MIME, byte count, exact preview, repair after an omitted directory, a blocked storage path, repeated failures, and rollback after an injected failure during source registration. It also checks the diagnostic endpoint's CSRF and payload restrictions and the exact audit record fields.
- Existing assertions were retained. The first pre-fix browser attempt stopped at the existing shell-language assertion because the temporary directory name included `json` and was visible as a path in settings. The next attempt used a neutral temp prefix and reproduced the upload banner.
- The first post-fix browser attempt passed the upload matrix, then DevTools rejected the fault-injection expression's return value because it was `File.prototype`. A standalone Chromium probe reproduced this debugger error. The test evaluates the setup for its side effect and keeps the failure assertions intact.
- The next attempt wrote both expected browser audit rows. The unexpected-client-error assertion caught a different generic message. The upload now shares the server's generic upload fallback.

## Verification

Each command used a fresh temporary `OEP_DATA_DIR` and the verification virtual environment. The gates ran sequentially.

| Command | Result |
| --- | --- |
| `npm run lint` | Exit 0, checked 287 source and configuration files |
| `npm run typecheck` | Exit 0, `tsc --noEmit` |
| `npm test` | Exit 0, 107 passed, 0 failed |
| `npm run build:release` | Exit 0, built `OEP-0.0.0-windows-x64.zip` |
| `npm run test:e2e:browser`, run 1 | Exit 0 in 140.39 s |
| `npm run test:e2e:browser`, run 2 | Exit 0 in 154.41 s |
| `npm run test:e2e:browser`, run 3 | Exit 0 in 148.20 s |
| `npm run test:release:determinism` | Exit 0, 1 test passed, both builds produced identical ZIPs |
| `npm run scan` | Exit 0, 760 files, 0 hits |

Release ZIP SHA-256 `32a1bc881af7566cb42737f687a5dc38b38c5776a99fcc2d653c5329d064038e`.

Each browser run printed `Benchmark JSON uploads and upload diagnostics passed in Chromium (paste, drop and file picker).` All three isolated runtimes reported zero orphaned processes.

`npm run test:e2e:web` is reserved for the reviewer.
