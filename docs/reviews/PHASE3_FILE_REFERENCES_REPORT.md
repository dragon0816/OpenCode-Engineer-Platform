# Phase 3 local file references

2026-11-23 · Windows 11 x64 · `phase-3/file-references` · base `c70d957`

## Implementation

- The owner can grant a Web session read-only access to one local file or a whole folder from the Windows picker, a pasted path, or a configured workspace read-only folder. An arrow distinguishes references from uploaded copies. The Files panel offers a bounded preview, Explorer, classification, reconfirmation, and revocation in Traditional Chinese and English.
- A selected reference adds its ID, name, plain Windows path, MIME type, and size to the Gateway turn. It uses the existing ticketed `oep_file_read` tool. An ID from another session or an unselected ID cannot read content. A folder read accepts a relative member name. A folder list returns up to 32 entries and an optional cursor. Existing uploads use their original storage, quotas, and tool arguments.
- The worker opens each Windows path component relative to a pinned handle. It rejects reparse points, multiple hard links on files, alternate data streams, UNC and device paths, mapped remote drives, Windows aliases, protected system or OEP roots, and known credential locations. It reads through the verified handle and checks the file again before returning data.
- The persisted identity contains the volume, file ID, creation time, modification time, change time, size, and a full streaming SHA-256 for files through 16 MiB. For larger files, every call verifies the metadata tuple and hashes the accessed range on demand. This keeps sparse and large files cheap to attach and seek. A folder pins its own identity and records each member's identity on the first successful access. Reconfirmation keeps the reference ID, resets member pins, clears a prior public mark, and retains a confidential mark.
- UTF-8 source, CSV and JSON retain their original byte offsets and syntax. XLSX uses the existing sheet-labelled CSV converter on the pinned stream. PDF reads one page's text at a time. Extracted bytes have their own cursors. Tool output is bounded to a 16 KiB range per call. PDF and XLSX also have parser resource and projection bounds. Scanned PDFs require OCR.
- Reference audit rows contain reference IDs, identity hashes, optional chunk hashes, actions, and timestamps. Revocation ends reads immediately. Confidential labels remain effective for alternate workspace-source export after a reference is revoked. Gateway references are outside the existing external-helper snapshot input types.
- The Web database adds three empty allowlisted tables. Version 10 leaves version 9 for the concurrent model-sources branch. The combined release should apply both migrations before distribution. If a database with only v10 has already been released, the combined build needs a newer migration to backfill v9.
- The PDF worker uses the pypdf pin from Phase 0. It is listed in the release requirements and the bundled wheel inventory. [PyPI wheel and checksum](https://pypi.org/project/pypdf/6.21.4/#files)

## Test notes

- The first focused run found an incorrect test fixture call to create a Web session. The corrected fixture passed.
- The first full test run stopped after `npm test` with 101 passing and 9 failing. The failures identified stale version assertions, a contract fixture missing the new allowlist, a missing i18n reference, and the paste branch's failing reproduction. The completed paste fix at `1360a78` and its later report were merged.
- The verification run passed the first two browser gates. The third passed the local-reference checks and then timed out at the existing Telegram management dialog focus assertion in `tests/e2e/agent-browser.ts`. The assertion remains in place. The gate sequence was restarted after tightening the credential-store checks and Explorer handoff.
- Existing migration assertions now expect version 10 where they previously expected version 8. The empty-table assertion includes the v10 tables and the v6-to-current fixture checks they start empty. The historical input versions and the strict equality and absence checks remain in place. No assertion was removed or weakened for this work.
- Each gate command uses a fresh temporary data directory. The Python verification venv is on PATH for the test process and contains the pinned pypdf wheel. Pinned OpenCode assets and source were copied from the main checkout, and the release cache was populated from those copies after hash verification.

## Gates

The final sequence ran against implementation commit `71db7d4`.

| Command | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 110 passed, 0 failed, 0 skipped |
| `npm run build:release` | Passed. Release ZIP SHA-256 `ca427a4bdf991430f0937e3d83a16eb9a9fec68334555081d656d1c617ed29ce` |
| `npm run test:e2e:browser` | Three passes, 163 s / 159 s / 150 s |
| `npm run test:e2e:knowledge` | 1 passed |
| `npm run test:e2e:mcp` | Passed |
| `npm run test:contract:native:isolation` | 5 passed. Pinned OpenCode 2.3.2 returned only the requested range for a selected reference and refused the unselected ID. No orphaned processes |
| `npm run test:e2e:delegation` | 4 passed |
| `npm run test:release:determinism` | 1 passed. Both ZIPs matched the release build checksum |
| `npm run scan` | 0 hits |

Gate outputs are under `.phase0/file-reference-gates/` in the implementation worktree. The running OEP instance and its installation and data were left in place.

## Reviewer

- The dedicated Web, Excel, install, upgrade, and backup gates are reserved for the reviewer. Chromium uses a fake picker with synthetic files. The native picker’s foreground placement and the Explorer handoff require a desktop smoke check.
- The concurrent direct Codex and Claude Code model-source work was outside this branch. This branch enforces the Gateway broker and the existing external-helper export boundary.
