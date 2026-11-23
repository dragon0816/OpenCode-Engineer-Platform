# Phase 3G slice 1 · Local plugin installation

2026-11-23 · Windows 11 · `phase-3g/slice-1-plugins`

The owner changed the admission policy on 2026-11-23. OEP accepts unsigned local packages and asks the owner to approve the declared permissions. Publishers are self-declared. SHA-256 detects a change relative to the bytes OEP accepted. The change replaces the provisional signing default. [Decision record](../DECISIONS.md)

## Owner workflow

Open **能力 → 外掛 → 從檔案安裝** and choose a `.oepplugin`. The preview shows the publisher, installed and incoming versions, data scope, workers and broker permissions. An update identifies newly requested permissions. A range mismatch requires a second checkbox before proceeding. An enabled page appears in **主功能** and opens in the middle area. The host uses the package's two language catalogs and renders the declarative view as text under the workbench CSP.

The registry stores the full archive SHA-256 in `web.sqlite` and the bytes under `plugins/packages/<id>/<version>/<artifact-id>.oepplugin`. A startup check or page request detects a change and disables the plugin. **重新安裝／信任目前版本** immediately accepts an internally valid replacement with the same ID, version, permissions and compatible range. Changes to permissions or a range mismatch open the confirmation dialog. A missing archive, an invalid manifest or inconsistent payload digests require **從檔案重新安裝** with a valid package. The registry retains previous archives until uninstall and offers rollback to the previous selection after checking its bytes and compatibility. Setup, upgrade and repair require the same declared data contract when switching an existing installation.

Uninstall removes the plugin's registry selection and managed package files. Workspace data under `plugin-data/<id>/` and published knowledge bases, assistant bindings and publication history are retained. The adapter serves the verified page definition through authenticated, same-origin JSON and uses the normal workbench shell for focus and layout. The package has no HTML or script execution entry point.

## Package an OEP plugin

1. Place a manifest template and the referenced files under `payload/` in a source directory. The template at [the synthetic fixture](../../tests/fixtures/plugins/synthetic/manifest.json) shows the required identity, SemVer compatibility range, permissions and component declarations. `name` is optional and falls back to the plugin ID. The page points to a declarative layout and matching `zh-TW` and `en` catalogs.
2. With Node.js 24 and the repository dependencies installed, run `node scripts/plugins/package.mjs <source-directory> <output.oepplugin>`. The tool writes `files` with each payload path, byte size and SHA-256, validates the resulting ZIP, and prints the archive SHA-256. Use a fresh output filename.
3. Select the resulting file in the Capabilities page. Use the declared OEP version range for the intended release. Source checkout builds use their `package.json` version and releases use `config/release.manifest.json`.

The reader accepts single-disk ZIPs with implicit directories, matching local and central headers, and no ZIP extras, comments or data descriptors. It limits archive size to 16 MiB, expanded contents to 32 MiB, payload files to 8 MiB each, and payload entries to 256. It checks CRCs, compression ratios, collisions and Windows path rules. OEP requires exact coverage of payload bytes by the manifest. A reserved optional `manifest.sig` ZIP member can carry a future signature envelope. V1 treats its bytes as opaque. A later verifier can add publisher authentication while preserving admission of existing unsigned packages. If the owner chooses production signing later, the earlier proposal calls for non-exportable hardware keys, dual-maintainer approval, a release ledger, and rotation and revocation through trusted OEP updates. [Original design](../design/PHASE3G_KNOWLEDGE_PLUGIN_DESIGN.md)

## Migration and scope

The branch started from `c70d957`. Web ledger v12 adds three empty plugin tables and reserves v9–11 for the parallel integration branch. The maintenance gate compares existing rows and plugin file sizes and digests. In the combined branch, retain the integration migration conditions and allowlists, add the three v12 tables, and keep 12 as the central Web target version. An isolated database created by this branch before integration jumps from v8 to v12 and should be recreated for combined-branch testing. Attachment, external-helper and custom-MCP implementations are outside this patch.

The fixture contains one bilingual page and one inert Python worker declaration. The worker is packaged and validated as a payload reference. Execution remains deferred pending OS-enforced Windows identity, ACL and network confinement. The workspace data, review, publish and progress APIs, panels, schema migration plans, and runtime registration of review types, collections, Skills and Workflows also remain open. BI Knowledge, `.oepkb` distribution and Share Platform are later slices.

## Assertion changes

Signature validity, unknown-key rejection and test-key fixtures were removed from the requested acceptance scope when the owner removed the signing requirement. The suite tests unsigned admission, optional envelope neutrality, payload and full-archive digests, compatibility consent and tamper recovery. Existing upgrade tests retain exact version assertions with their expected central Web version advanced from 8 to 12. The historical repair fixture copies the pinned SemVer dependency as a release would. The allowlist coverage still enumerates every Web table and now includes the three plugin tables. Existing assertions retain their original coverage.

## Gate output

Commands ran sequentially on Windows using a fresh temporary `OEP_DATA_DIR` per command and the verification Python venv in the test process. The initial full suite had 109 passes and four failures from old schema expectations, the repair fixture's missing SemVer dependency and localization keys the catalog test could not trace. The second run passed 112 tests and exposed one more exact migration-retry version expectation. The third run passed all 113 tests after advancing that expectation to 12. The initial release build stopped on the ISC license classification. The rebuild passed after ISC was classified as permissive. The first broad Chromium run began before the localization correction. The next two ran with the correction in place.

| Command | Observed output |
| --- | --- |
| `npm run lint` | Exit 0. Checked 302 source and configuration files. |
| `npm run typecheck` | Exit 0. `tsc --noEmit`. |
| `npm test` | 113 passed, 0 failed, 0 skipped on the final run. |
| `npm run build:release` | Exit 0 on rerun. `OEP-0.0.0-windows-x64.zip` SHA-256 `dc66663fbf49833f99b1e1f9d19c0fdb2cf031b3c8212715fd6192535b1e1b75`. |
| `npm run test:e2e:browser` ×3 | Exit 0 for all three runs in 140, 145 and 146 seconds. All reported `orphans: 0`. |
| `npm run test:e2e:knowledge` | 1 passed, 0 failed. |
| `npm run test:ingest` | 16 passed, 0 failed. |
| `npm run test:contract:native:isolation` | 5 passed, 0 failed. Covers the existing host contract. Plugin Python isolation remains pending. |
| `npm run test:release:determinism` | 1 passed, 0 failed. Both ZIP hashes were `dc66663fbf49833f99b1e1f9d19c0fdb2cf031b3c8212715fd6192535b1e1b75`. |
| `npm run scan` | Exit 0. Scanned 775 files with 0 hits. |
| `npm run test:plugins` | 6 passed, 0 failed, including Chromium consent, narrow keyboard navigation, bilingual page rendering and recovery. |

During development, the plugin Chromium probe first timed out during bootstrap because its stub omitted the redaction function. A later probe timed out at keyboard activation. The final probe supplied the missing stub and dispatched Space with text through Chromium to exercise native button activation. Its standalone rerun and the full plugin suite passed.

The owner's running installation and data roots were outside the verification. `test:e2e:web`, Excel, installer, upgrade and backup gates are reserved for the reviewer.
