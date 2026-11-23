# Phase 3G slice 1B · Plugin workers and owner review

2026-11-23 · Windows 11 · `phase-3g/slice-1b-plugin-runtime` · base `a7ffd67`

## Package and launch a worker

Declare a Python entry in `components.pythonWorkers`, repeat its ID in `permissions.workers`, and request `worker.run`. The entry is a verified payload-relative `.py` file that exports `run(input)` and returns a JSON value. An optional `timeoutMs` is 1,000–600,000 ms and defaults to 120,000 ms. OEP gives staging and isolation probes up to 30 seconds before the worker deadline starts.

Place pure-Python packages under `payload/vendor/`. Imports also resolve from the package root and the entry's directory after the isolated standard library. Native libraries and wheels belong in the OEP-managed Python 3.12 environment. Declare each installed distribution and top-level module, including transitive distributions the worker uses, in the entry's optional `dependencies` array. For example, `[{"distribution":"python-docx","module":"docx"}]` declares the installed distribution and import name. OEP verifies distribution metadata and the module path at install, checks again before launch, and stages the declared installed files. Missing dependencies produce `plugin-python-dependencies` in both languages. OEP runs the isolated interpreter without site initialization and never invokes pip. [Synthetic package](../../tests/fixtures/plugins/synthetic/manifest.json)

## Windows boundary

Every job runs in a fresh less-privileged AppContainer. OEP checks its package SID and sole `registryRead` capability before resuming the Windows Job member. That capability lets desktop Python initialize using OS registry resources. The Job permits one active process with a 768 MiB process memory limit. The verified package and Python runtime copy have read/execute access for the container. The container profile has a medium-integrity label, and worker input and output travel over inherited stdio. Worker startup checks read denial for a private file, write denial for the staged runtime and Windows profile, and socket denial for loopback and external IPv4 and IPv6 targets. Windows firewall services must be running. Startup fails closed with `isolation-unavailable` if those checks fail.

OEP gives the worker a minimal environment. The Gateway URL, credential and relay authorization stay in the host. No plugin content is executed by the host interpreter. Worker stderr is discarded and status events contain bounded JSON. Cancellation, timeout and adapter shutdown close the Job. The supervisor keeps a handle to the adapter process and terminates the Job if the adapter exits. Startup retires abandoned staging directories and AppContainer profiles whose owners have exited.

## Page API and activation

The host renders `oep.plugin.page/v1` pages in the work area and opens declared panels in the right-side preview. An optional page `actions` array accepts `worker`, `labelKey`, and optional `panel` and `reviewType` IDs. A review action can select a file, create a draft, start its worker and show the live job status. Labels resolve through the page's `zh-TW` and `en` catalogs. The page runtime is host JavaScript and consumes the archive's declarative components.

`GET /api/plugins/{plugin}/pages/{page}/{digest}` returns a grant for the installed activation. Browser calls use `X-OEP-Plugin`, the paired browser cookie and the existing CSRF header for POST. `POST /api/plugins/{plugin}/runtime` accepts `{"method":"…","params":{…}}`. The grant expires after 30 minutes and is bound to its plugin, paired browser and activation generation. `GET /api/plugins/{plugin}/runtime/events/{job}` streams current job state and progress as SSE using the same grant. Jobs and selected source IDs live in the adapter process.

| Page method | Contract |
| --- | --- |
| `components.list` | Returns the active worker IDs, panel IDs, review types and collection declarations. |
| `jobs.start` | Pass `worker`, optional `input` and an array of selected `sources`. Returns a job ID. One active job per plugin, three across the adapter, and 32,000 bytes of job input. |
| `jobs.status`, `jobs.cancel` | Pass the owning job `id`. Terminal states are `succeeded`, `failed`, `cancelled` and `timed-out`. |
| `sources.reference` | Pass a Web `session`, an explicit attachment or workspace source ID in `source`, and its expected `sha256`. OEP checks the existing Web source scope and digest. |
| `sources.url` | Pass the owner's exact `url`. OEP fetches public HTTPS text through the existing pinned-address link broker. Redirects, local addresses, user-info and other content types are rejected. |
| `sources.list`, `sources.read` | List selected source IDs and metadata. `sources.read` takes `id` and includes `base64`. |
| `data.read`, `data.write` | Use a relative `path`. Read returns `base64`, and write takes `base64`. Maximum 128 KiB per file. OEP checks the path and atomically replaces files within `plugin-data/{plugin}/`. |
| `drafts.create` | Pass a declared `reviewType` and `title`. Returns a BI workspace ID with no publication. The manifest schema used by this bridge provides a `fields` array. |
| `reviews.status`, `publish.request` | Pass the owned review `id`. Publish request returns a hand-off to the built-in owner review area. |

Upload an explicitly chosen file using `POST /api/plugins/{plugin}/runtime/sources` with `application/octet-stream` and URI-encoded `X-OEP-Filename`. Sources require `sourceBroker: approved-sources`. OEP caps each source at 8 MiB and each grant at 16 sources or 16 MiB total. The worker receives only the explicit subset listed in `jobs.start`.

Enablement exposes verified declarations in the navigation and API. Disable, uninstall, package replacement and detected tampering revoke grants and stop active jobs. Binary packages are removed through the slice 1 uninstall path. OEP retains plugin data, host draft and review receipts, and published knowledge bases. Existing owner review records stay in the host review ledger.

## Worker API and BI hand-off

Use `from oep_plugin import call, progress, read_source, read_data, write_data`. The helpers wrap JSON-RPC 2.0 over newline-delimited stdio. Requests use sequential integer IDs with object parameters. The worker receives an input object from the page. Expected broker rejections raise `oep_plugin.BrokerError` with a safe code. A job can make up to 512 calls and 32 data writes. `progress(percent)` emits a monotonically increasing integer from 0–99 when `progress.emit` is granted. OEP emits 100 on success.

`models.complete` takes `prompt` and optional `input` and returns `{content}`. It requires `modelBroker: approved-gateway` and uses the host's active Gateway alias and model seat. OEP limits model calls to eight per job, with a 4,000-character prompt and 24,000 bytes each for serialized input and output. A job with a confidential source cannot call the model broker. Model time counts against the job deadline.

The worker can create a draft with `drafts.create` or receive its ID as `input.draft`. Call `reviews.propose` with `draft`, a selected `source` ID, and `proposal`. A proposal is `{"title":"…","fields":{"fieldName":{"value":"…","quote":"…"}}}` or `{"cards":[…]}` with up to 24 such cards. One proposal may be queued per job. It stages after successful Python exit and rechecks the activation, source hash and each required field's contiguous quote through the existing `proposeReview` and BI change-set verifier. The resulting review ID appears in job status. The current bridge verifies against one exact UTF-8 source of at most 1 MiB. Output remains pending until the owner approves and separately publishes through OEP's ordinary review actions. [Host review implementation](../../apps/adapter/src/http/review.ts)

To try the synthetic builder, package the fixture with `node scripts/plugins/package.mjs tests/fixtures/plugins/synthetic <new-output>.oepplugin`. Install it from Capabilities, choose a short UTF-8 text file, enter a knowledge base title, and choose **Build synthetic knowledge**. Open the owner review and inspect the quotation before approving and publishing. The Chromium test exercises the bilingual controls and right panel. The HTTP test covers invalid evidence, actual owner publication and retained publication after uninstall. [Package fixture](../../tests/fixtures/plugins/synthetic/manifest.json)

## Scope and assertion history

The BI extraction port, verified PDF or Office normalization for review evidence, multi-source review batches, plugin data migration plans, Skills and Workflows, and collection record APIs remain follow-on work. The registered collection declarations expose their schema, scope and review policy. The runtime provides in-process job status and cleans abandoned jobs on restart. Durable job history and replay are outside this slice.

All slice 1 assertions retain their coverage. The slice 1 helper still emits the earlier permission shape for the original consent and recovery assertions. Its package-on-disk fixture now declares the full worker flow. The suite adds actual worker confinement, timeout, cancel and owner-loss checks, a native payload rejection, source references and cross-plugin grant checks, progress in Chromium, and a verified review ending in owner publication.
