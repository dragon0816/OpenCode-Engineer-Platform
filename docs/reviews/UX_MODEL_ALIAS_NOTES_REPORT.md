# Gateway model alias notes

LiteLLM documents `GET /model/info` and registers `GET /v1/model/info` on the same authenticated handler. OEP tries the versioned route first, then the unversioned route under the configured base path. Both use the existing key, manual redirect handling, bounded JSON parsing, and the catalog refresh's eight-second deadline. Model info requires HTTPS, with HTTP allowed on loopback for local gateways. [LiteLLM model management](https://docs.litellm.ai/docs/proxy/model_management#automation-api) · [LiteLLM route definitions](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/proxy_server.py#L17627-L17639)

The public model list determines which mappings OEP accepts. OEP keeps distinct, unambiguous underlying model IDs after stripping their LiteLLM provider prefix. Upstream hosts, keys, and arbitrary response fields stay out of SQLite and the UI. Unavailable model info falls back silently to the public list. A successful public refresh replaces automatic mappings with the current results. An unsuccessful public refresh keeps the cached list and mappings.

Settings pre-fill each note from discovery when available. Saved owner text takes precedence, and saving a blank field hides the annotation. Note-only saves apply immediately without scheduling a restart. Web schema v13 adds the notes table. Upgrade reconciliation requires an empty table on migration and compares existing note rows on subsequent upgrades. Settings, the assistant model tab, the assistant wizard, and the composer show the annotation alongside the public alias.

## Verification

All gates passed in order. Each command used a fresh temporary `OEP_DATA_DIR` and the verification Python environment.

| Gate | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 125 passed |
| `npm run build:release` | Passed on retry |
| `npm run test:e2e:browser` | 2 passed, with all four pickers exercised in zh-TW and en each time |
| `npm run test:release:determinism` | Passed on retry, with identical ZIPs |
| `npm run scan` | 0 hits |

An initial release build and the second build within the first determinism run each returned the generic build error. Both gates passed on retry with the same code and pinned release inputs.

The live probe retrieved the public list. The configured remote gateway uses HTTP, so model-info requests were skipped and live mappings remain unavailable.

Existing discovery assertions now cover the original list request and both metadata requests. Chromium selectors now target checkboxes so the existing exact list checks continue to validate model selection alongside the new note fields. Upgrade version assertions expect v13, and the fixture matrix includes an actual v12 starting schema. All existing data-preservation checks remain in place.
