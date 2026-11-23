# Phase 3G BI document OCR

## Demo

1. Run the candidate with a separate data root. Use the bundled build for its private Python runtime, or use an isolated Python 3.12 environment with `python -m pip install --require-hashes -r tests/oracles/requirements.txt`. Under **Capabilities → Plugins**, install or update BI Knowledge to `1.1.0` with `dist/plugins/BI-Knowledge.oepplugin`.
2. Open **BI Knowledge** and choose a scanned PDF, a mixed PDF, or a PNG/JPEG. Keep **Detect automatically (English first)** and **Use model recognition when needed** for an English technical scan. Pick **Traditional Chinese (Taiwan)** for a known Traditional Chinese scan. Choose **Local OCR only** to keep page images on the computer. Card extraction sends the converted text to the configured Gateway under the existing extraction workflow.
3. Run **Convert and extract**. In **Sources**, a mixed PDF should show **Text layer** for the readable pages and **Local OCR** for clear scans. **Use model recognition** requests vision for raster pages even when local OCR has recovered text. A Gateway rejection leaves the local result and displays the reason on the page row.
4. Verify the quoted value against the original page, submit the card, and open the review. The review displays the OCR engine alongside the citation. Approve and publish, then ask an assistant with read access to the knowledge base. Its citation includes the filename and page number.

## Implementation

- `pypdf` reads each PDF page. Readable text is used directly. Pages with no usable text, including a scan with just a page-number footer, are rasterized with `pypdfium2` inside the BI worker's Windows AppContainer. Page PNGs are held in memory. The Windows x64 wheel pin is `74d1bace34fb01c660d0b64344d5a4b7d276942b7c6623c88ab59ea21c5acfbd`. The binding is licensed `Apache-2.0 OR BSD-3-Clause`. The wheel includes BSD-style PDFium build 8149 and ships notices for its dependencies. NOTICE, the CycloneDX SBOM, and third-party terms identify the renderer distribution. The bundled archive includes the wheel payload and verifies PDFium can render a page. [pypdfium2 5.15.2 wheel and license metadata](https://pypi.org/project/pypdfium2/5.15.2/)
- The BI worker's OCR broker invokes a fixed Windows PowerShell 5.1 helper with a sanitized environment, byte input over stdin, and an eight-second deadline. The helper runs as a host subprocess with no Gateway credentials. Windows PowerShell's native WinRT projection worked on this machine and kept the release free of a Python WinRT dependency. Windows OCR returns line text and a union of the word rectangles in decoded image pixels. Auto tries installed en-US and zh-Hant-TW and keeps the higher-scoring reading, with English first on ties. Windows OCR exposes no per-word confidence, so text yield and recognizer noise determine when to try vision. [Windows OCR API](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine) · [Word bounds](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrword)
- The OEP relay sends OpenAI-compatible image input to an approved, owner-selected GPT-5 alias. A four-color synthetic image tests whether the model sees the image before a document page leaves the machine. The cache is scoped to the relay and alias. Confirmed capability results expire in one hour. A subsequent source can retry a transient probe failure after 30 seconds. Each source can request up to eight vision transcriptions at 4,096 output tokens each through the existing shared model seat. Local results remain usable when vision cannot run. The legacy document panel uses local OCR.
- The document limit remains 10 MiB and 120 PDF pages, with the plugin's existing 8 MiB source upload limit. PDF rendering caps the longest side at 2,600 pixels. The OCR helper also bounds image dimensions. BI keeps the existing 12-minute extraction deadline. Gateway audit rows contain status and timing metadata. They contain neither image bytes nor recognized text.
- Each OCR segment has `page:N` and an OCR engine marker. The verifier checks the proposed quote against the OCR text from the selected page. A failed quote stays out of the draft. Published OCR evidence retains the page and engine in its locator without requiring a snapshot migration. New OCR projections can change between recognitions, so the extraction receipt reflects the text and engine that supplied the evidence.

## Gateway probe

With `OEP_LIVE_GATEWAY=1`, `node scripts/phase0/probe-bi-vision.ts` returned `unsupported gpt-5.4-mini`. This alias did not pass the synthetic probe. It received no document images. The synthetic Gateway suite verified successful transcription, cached acceptance, rejection without a page upload, and local text preservation.

## Verification

The Windows 11 x64 worktree used Node 24.14.1, npm 11.11.0, and Python 3.12.7. Setup ran `npm ci`, copied `.phase0/assets` and `.phase0/source` from `main`, and activated Phase 0 hooks for the worktree. Each command received a new temporary `OEP_DATA_DIR`. The verification venv was first on `PATH` and selected by `OEP_PYTHON` within the gate runner. The running OEP 0.9.0 instance was left alone.

No existing assertion was deleted or loosened. The bundled Python check still imports and verifies the original dependencies and now checks that PDFium can render. The OCR fixtures generate their own raster text and image-only PDF. The mixed fixture includes a real text page and a scanned page with only a footer in the text layer.

The first ordered run exposed an upload help-text mismatch in the adapter fallback catalog. The adapter and browser now share the same list of formats, and the exact catalog assertion remains in place. Plugin installation and release packaging also failed before reaching OCR. A diagnostic preload reported `ETIMEDOUT` from the existing two-second Windows Python path probe during release packaging. OEP now retries that check once with a five-second deadline when the subprocess times out. Both runs apply the same full path checks, and a non-timeout failure still stops the operation immediately.

The bundled build also rejected a license filename with `+` in the pinned wheel. The wheel unpacker now accepts that character and still rejects traversal and unsupported wheel layouts. The bundled determinism test checks for the license file and the DLL.

The final ordered run verified code at `6e842cad77f005be01e07f83df088a5783efd52c`.

| Command | Exit | Time | Observed result |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.3 s | 386 source and configuration files checked |
| `npm run typecheck` | 0 | 6.5 s | TypeScript completed |
| `npm test` | 0 | 28.8 s | 122 passed, zero failures or skips |
| `npm run build:release` | 0 | 21.4 s | Standard Windows x64 ZIP built and scanned |
| `npm run build:plugin:bi` | 0 | 1.3 s | BI Knowledge 1.1.0 packaged |
| `npm run test:e2e:browser` first run | 0 | 165.2 s | Chromium passed with zero orphaned processes |
| `npm run test:e2e:browser` second run | 0 | 163.6 s | Chromium passed with zero orphaned processes |
| `npm run test:bi-extraction` | 0 | 11.4 s | 1 passed |
| `npm run test:e2e:bi-plugin` | 0 | 36.5 s | 1 passed, 1 opt-in owner export skipped |
| `npm run test:plugins` | 0 | 51.4 s | 9 passed |
| `npm run test:release:determinism` | 0 | 50.3 s | Two standard ZIPs matched byte for byte |
| `OEP_TEST_BUNDLED=1` with `npm run test:release:determinism` | 0 | 66.3 s | Two bundled ZIPs matched and the embedded Python rendered a page with PDFium |
| `npm run scan` | 0 | 1.9 s | 884 tracked files, zero hits |
| `npm run test:bi-ocr` | 0 | 40.4 s | 3 passed, zero skips, including local WinRT OCR and both Chromium locales |
| `npm run build:release -- --bundled` | 0 | 27.3 s | Bundled candidate built and scanned |

`npm run test:compliance` also passed both tests. The standard ZIP SHA-256 is `b2bffd12a7ff0bd07ddf2d676d7a5526d70a89358368b7d4b4dd1d474afacfc7`. The bundled ZIP SHA-256 is `79732dbc22439e7d5675a0e1fee7503c383d75cefa13076aac83b9d183b21ec6`. The BI plugin SHA-256 is `168d7d3040e7cf84f9eb91cf6bce63c60145b0f21a9322063bf4610cf4daa5f6`.

### Per-page timings from the OCR suite

| Path | Elapsed |
| --- | ---: |
| Local, image-only PDF page including rasterization | 746 ms |
| Local, PNG | 481 ms |
| Local, JPEG | 498 ms |
| Local, mixed PDF with one text page and one rasterized page | 761 ms |
| Synthetic Gateway image probe through the relay | 23 ms |
| Synthetic Gateway transcription through the relay after the probe was cached | 5 ms |

Local timings include worker and PowerShell startup. The synthetic Gateway returns a fixed transcript so its timing measures relay overhead. The live alias did not pass the probe, so there is no live transcription timing.

## Remaining validation

- Owner validation with real technical scans and Traditional Chinese OCR selection.
- Live Gateway transcription and per-page latency on an approved model that passes the image probe. The synthetic relay test measures OEP transport overhead.
- File-reference OCR previews remain outside this change. Reviewer retains the dedicated Web HTTP, Excel, install, upgrade, and backup gates.
