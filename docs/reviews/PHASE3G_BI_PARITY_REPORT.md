# Phase 3G BI Knowledge parity

The local `phase-3g/bi-parity` branch starts at `81aa701` and packages BI Knowledge `1.2.0`. The builder opens an empty knowledge base or an editable AEP working draft. Its Convert, Ingest and Testing panels use saved settings for the selected schema or working base. Owner review and publication remain separate actions in 審核. Assistants query the published version through OEP core.

## Parity with AEP

| Area | OEP implementation | Remaining AEP behavior |
| --- | --- | --- |
| Convert | Choose a file or public HTTPS URL, set the reader, and inspect converted segments and the run log in Details. Text-layer PDF, HTML, plain text, Markdown and CSV-as-text work through the plugin worker. Each run can continue automatically or pause after Convert and Ingest. | The independent OCR branch supplies Windows OCR, page-level recognition settings and Gateway vision. Manual runs take one source. AEP has multi-source selection and richer revision and reader controls. |
| Ingest | Select the OEP review schema or import an AEP schema projection. Choose rule-based field-label mapping or a Gateway model. Configure the labels, duplicate handling and minimum distinct evidence. The host checks exact quotations and field coverage and can propose updates to matching records. | AEP versioned methods, richer recipes, card-type semantics, multi-type packs, field inferences, relationship generation, and extraction retries by missing chunk. A workspace keeps the review schema selected at creation or import. |
| Testing | Save and switch among named sets of questions and expected excerpts or abstentions. Each set has a model, a pass threshold and evidence checks. Test the candidate snapshot and inspect answers by question. A failed run stays out of Review. | AEP also compares working and published reports, scores extraction cases, and tracks regressions across domains. |
| Create and working import | Create a named empty workspace with a schema. Import root `bi.sqlite`, or replay exported `commits/<author>/<seq>.json`, optional `work/commits` and `work/pending.json`. Inspect and edit card titles and JSON field values, then prepare the draft for owner review. The existing published-snapshot import remains available. | Raw source attachments, pending proposal units, schema overlays, Git-style sync and arbitrary AEP vault skills or tools are outside the projection. Commit replay is bounded by the broker, and the real owner export remains unverified. |
| Assistant binding | A model-enabled, published BI binding activates the BI query procedure plus filtered card search, linked card navigation and the existing evidence-verifying Ask tool. The tools work after the builder is removed. | AEP's dynamic vault skills, analytics, domain packs and user-defined tools are outside this port. |
| Telegram | The owner chooses a target, daily time and IANA zone. An approved URL or supported file waits in `bi_sources`. `BiScheduler` and the common dispatcher run Convert and Ingest with the target's saved settings and stage candidates on 審核 with Telegram source receipts. | There is one inbox schedule and a limit of 25 sources per occurrence. Scheduled candidates from the same base can become stale if another pending candidate publishes first. AEP's larger file-format set and batch merge are outstanding. |

## Source and integration

- AEP HEAD was `861d0c0ca0813073f3944d4aff88818980beff2a`. The source-only shallow checkout was made in the Windows temporary directory. The verified folder was moved to the Recycle Bin after the source review. No AEP data, fixtures, configuration, or credentials were copied into OEP. [Pinned AEP source](https://github.com/dragon0816/agentic-engineering-platform/tree/861d0c0ca0813073f3944d4aff88818980beff2a/feature_plugins/bi_knowledge)
- `plugins/bi-knowledge/payload/recipes.py` adapts the field mapping and original evidence behavior of `cards/recipes.py`. `worktree.py` ports canonical commit IDs, ordered operation replay and pending overlays from `src/knowledge/repo/repository.py`. `working-repository.ts` adapts the card, field, evidence and relation projection in `cards/vault.py`. The existing `convert.py`, `html_markdown.py`, `extract.py`, `catalog.py`, `staging.py` and OEP evidence-validation ports remain in the pipeline. [AEP card code](https://github.com/dragon0816/agentic-engineering-platform/tree/861d0c0ca0813073f3944d4aff88818980beff2a/feature_plugins/bi_knowledge/python/aep_bi/cards) · [AEP repository replay](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0ca0813073f3944d4aff88818980beff2a/src/knowledge/repo/repository.py)
- The Testing runner adapts `host/bi_bench.py` to OEP's Gateway relay and evidence verifier. Card queries and the default BI skill adapt `host/bi_cards_tools.py` and `host/bi_assistant_query.py`. The three panels and the run details are based on `host/bi_page.py`. Telegram uses OEP's leased dispatcher and existing source ownership and approval flow for the intake behavior referenced in AEP `inbox/process.py` and `inbox/scheduler.py`. [AEP host code](https://github.com/dragon0816/agentic-engineering-platform/tree/861d0c0ca0813073f3944d4aff88818980beff2a/feature_plugins/bi_knowledge/python/aep_bi/host) · [AEP inbox code](https://github.com/dragon0816/agentic-engineering-platform/tree/861d0c0ca0813073f3944d4aff88818980beff2a/feature_plugins/bi_knowledge/python/aep_bi/inbox)
- Workspace edits and settings live in `plugin-data/oep.bi-knowledge/workspaces.sqlite`. Conversion projections, run checkpoints and review receipts extend the existing BI document ledger. A run keeps its stage settings, schema and working-draft revision when it pauses. Published versions, search and model permissions remain in the core knowledge store.
- Python parsing, conversion and rule extraction go through the existing plugin broker. The host keeps URL fetches, Gateway calls, workspace writes and all review effects. The OCR merge can extend the Convert settings and the existing `worker<Projection>` call with its recognition callback. Preserve the Convert checkpoint's completed projection ID and use the scheduler's approved origins for Telegram. BI parity uses package version `1.2.0` so it can follow the OCR candidate's `1.1.0`.
- A metadata-only check of the owner example confirmed the portable `commits`, `schemas`, `tags`, `publish` and `published` layout. Its commit files exceed the original replay limits. The working importer accepts up to 8 MiB per record, 24 MiB of broker input and a 20 MiB projected result. The browser test expands the committed synthetic export with four 3 MiB commits. It reads no files from the owner export.

## Thursday demo

1. Start the candidate with a separate OEP data root. Install or update `dist/plugins/BI-Knowledge.oepplugin` from 能力 → 外掛 and open BI 知識庫.
2. Enter a name and choose **Create knowledge base**. In **Ingest**, select **Field-label rules** and enter `content = Reading`. To demo model Testing and later assistant Q&A, enable model use before creating the workspace. In **Testing**, enter `What is the SYN-GAMMA calibration limit? = 23 mm`, choose a model and save the stage settings.
3. Save the following synthetic source as a UTF-8 `.txt` file. Choose **Step by step**, run **Convert**, and open **Run details and evidence**. Inspect the paragraph, run **Ingest**, inspect the candidate, then run **Testing**. Use **Fully automatic** on another source with a matching saved question set to show the stages advancing together.

   ```text
   Name: SYN-GAMMA
   Reading: SYN-GAMMA calibration limit is 23 mm.
   ```

4. Choose `tests/fixtures/knowledge/bi-working-export` with **Import working draft**. Use **Edit working cards** to open the card whose title ends in “Working Draft.” Edit its title, save it, and choose **Prepare working draft for review**. Submit it, approve and publish on 審核.
5. Bind the published base to an assistant and ask for the SYN-GAMMA baseline and its linked card. The synthetic source says `21 mm` with locator `#L2-L2`. The assistant should cite the evidence when answering the baseline and use the relationship tool to inspect the linked card.
6. For Telegram, use a demo bot or the synthetic test. In 排程與工作 configure the BI bot and its approved HTTPS origin. In Convert, choose the target and save **Telegram inbox schedule** for `09:00` in `Asia/Taipei`. Send a supported file or approved URL. The source waits for its slot, and the resulting review includes a page or web locator. **Run now** in 排程與工作 can demonstrate the same job without waiting for 09:00.

## Verification

Windows x64 used Node `24.14.1`, npm `11.11.0`, and the test-only Python `3.12.7` venv. Setup ran `npm ci`, copied `.phase0/assets` and `.phase0/source` from the main checkout, and activated Phase 0 hooks in the worktree. Each gate got a fresh temporary `OEP_DATA_DIR`. The installed OEP and its data and program directories were outside the test paths.

The preflight BI plugin regression passed. The new stage test initially caught an empty default model alias rejected by settings validation. After that fix, Chromium did not activate the button with the injected Enter. The passing test used native Space activation and asserted focus, stage transitions, both benchmark outcomes, working-card editing, publication and three brokered assistant tool calls. The synthetic Telegram preflight also passed.

The first ordered `npm test` exited 1 in 29.18 seconds. The locale contract checks literal calls to `message` and reported BI's dynamic message lookups as unused. The fix gives both catalogs static key references and removes the obsolete Validate label. The unchanged locale test then passed. No existing assertion was deleted or loosened.

The first ordered knowledge E2E exited 1 in 5.53 seconds. Its bilingual lookup resolved the new BI “Run log” label for the existing Jobs text. BI now reuses the workbench's run-history label and gives its testing and working-card labels their own context. The targeted knowledge retry passed with one test and zero failures.

The first determinism run exited 1 in 43.59 seconds after building two different ZIPs while implementation files were changing for the import-size fix. The first parity suite ran the larger import case against the earlier plugin artifact and timed out, with one test passed and one failed. Rebuilding the plugin and running the larger import in isolation passed with one test and zero failures. The fixed-tree run below is the release result. Both archive-equality and byte-level plugin assertions remain intact.

The second ordered run passed both Chromium runs, knowledge, ingest, Telegram, extraction, isolation, determinism and scan. `npm test` had 119 passes and three plugin registry failures in the Windows path probe. The standalone plugin build failed in the same probe. Two BI plugin cases and the isolated BI parity cases timed out waiting for installation. The serial plugin suite had six passes and three failures, including two path-probe failures and a browser install timeout. BI reuses the bounded probe retry from OCR commit `7d10e6d0af21404574048a8c16c06fdc79f70cf1`. The original check runs first, and only a subprocess timeout retries it. Reparse-point and file-identity checks still apply before opening files.

The first two BI plugin E2E attempts after the probe fix installed successfully in all three cases. The new stage case reached Ingest during the second automatic run, but its 15-second browser wait for the Testing report expired. Closing the test adapter then interrupted that run. Worker-dependent waits in the new test now allow 60 seconds, matching the existing BI browser test. The expected stage transitions, 100% failure threshold, evidence and owner-review assertions are unchanged. The new parity suite passed with the revised waits, followed by the full BI plugin E2E retry.

Ordered output and prior attempts are in `.phase0/bi-parity-gates/` in this worktree. Logs for the candidate with the path-probe retry are in `verified/` under that directory.

| Gate | Exit | Seconds | Observed output |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.39 | 390 source and configuration files checked. The test-only follow-up passed in 1.32 s. |
| `npm run typecheck` | 0 | 5.83 | TypeScript passed. The test-only follow-up passed in 6.46 s. |
| `npm test` | 0 | 28.84 | 122 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 19.75 | Windows ZIP built and scanned |
| `npm run build:plugin:bi` | 0 | 3.06 | `dist/plugins/BI-Knowledge.oepplugin` built |
| `npm run test:e2e:browser` run 1 | 0 | 160.86 | Chromium passed, 0 orphan processes |
| `npm run test:e2e:browser` run 2 | 0 | 167.19 | Chromium passed, 0 orphan processes |
| `npm run test:e2e:knowledge` | 0 | 32.17 | 1 passed, 0 failed |
| `npm run test:ingest` | 0 | 4.40 | 16 passed, 0 failed |
| `npm run test:telegram` | 0 | 37.86 | 8 passed, 0 failed |
| `npm run test:bi-extraction` | 0 | 14.01 | 1 passed, 0 failed |
| `npm run test:e2e:bi-plugin` retry | 0 | 131.23 | 3 passed, 0 failed, 1 opt-in skip. Two attempts with the original browser wait took 121.78 s and 116.97 s, each with 2 passes, 1 timeout and 1 opt-in skip. |
| `npm run test:plugins` | 0 | 88.54 | 9 passed, 0 failed |
| `npm run test:contract:native:isolation` | 0 | 27.87 | 5 passed, 0 failed, 0 orphan processes |
| `npm run test:release:determinism` | 0 | 42.59 | Both ZIP hashes matched. The test also compared the plugin payload bytes. |
| `npm run scan` | 0 | 1.87 | 888 files, 0 hits |
| `npm run test:bi-parity` | 0 | 88.58 | 2 passed, 0 failed, 0 skipped |

Windows ZIP SHA-256 `67ea18684a958907e87fd3e3dcb913e983b45420e0d3c40ac00adcb0205f4fee`. BI plugin SHA-256 `b4ee6389fca998ba6d136de6fdf4398291630f6024cb7db977ec2aab909c6d07`.

## Reviewer follow-up

- Merge and verify the OCR, capabilities page and BI changes together. The independent OCR package introduces dependencies and release-license changes that are documented on its branch.
- Verify the real working-export shape with **Import working draft**. The existing optional `OEP_MARKET_INTEL_DIR` test exercises the published-snapshot path and can also use `OEP_LIVE_GATEWAY=1`. Neither real-data path ran on this branch. The synthetic working export is committed and the published-snapshot regression generates its own SQLite export.
- Run the Web HTTP, Excel, install, upgrade and backup gates reserved for reviewer acceptance.
