# Phase 3a　唯讀知識操作與驗證

2026-11-21（Asia/Taipei）。Windows x64、Node 24。啟動入口沿用 `scripts/windows/Start-OEP.vbs`。左側「知識庫」顯示已發布的 BI 或 Wiki 快照與索引狀態。選擇單一庫後送出問題，答案由通過驗證的逐字摘錄組成。展開引用可查來源名稱、定位、原段、來源版本及 SHA-256。回到「對話」可接續原會話。

一般聊天可呼叫內建 `oep_knowledge_ask`。使用者可把知識頁顯示的庫識別碼填入提問，模型自行決定是否呼叫工具。工具與明確 Ask 走同一套查詢和驗證。工具輸出含驗證結果，後續聊天文字由 OpenCode 模型處理。 [Gate 報告](../reviews/PHASE3A_GATE_REPORT.md)

## 快照契約

| 欄位 | 規則 |
|---|---|
| `format`、`status` | 分別為 `oep-published-snapshot/1`、`published`。輸入為本機 UTF-8 JSON 或 gzip，解壓內容上限 32 MiB。 |
| `vault` | `id`、`title`、`kind`，kind 為 `bi` 或 `wiki`。相同 ID 的庫類型固定。 |
| `publication` | `revision`、帶時區的 ISO `publishedAt`、`publisher`，可帶前版 `parent`。同 ID 及版本內容固定。依時間、自然版本字串順序選目前發布版，較舊匯入保留歷史。 |
| `schema` | `id`、`version`、`document`、`sha256`。雜湊基於 UTF-8 緊湊 JSON，物件鍵排序、陣列保留順序。 |
| `sources` | 各含 `id`、來源標記 `ref`、`version`，可帶原始內容 `sha256`。來源標記供顯示與追溯。 |
| `cards`、`relationships` | 卡片含 `id`、`type`、`key`、`title`、`version`、`fields`。版本內卡片 ID 及 type/key 唯一。關係含 `from`、`to`、`kind`，首尾皆須是同版的卡片。 |
| `passages` | 各含 `id`、`sourceId`、`locator`、`text`、原段 UTF-8 的 `sha256`，可帶 `cardId`。段落最多 4,000 個 UTF-16 字元單位，定位對應同一封存版。 |

AEP BI 接受 `aep-bi-dataset-snapshot/1` 且有 publication 欄位的 JSON/gzip，檢查原封裝及 schema digest。Python 3 僅用於重現其 JSON 浮點數編碼。此交換格式可讀到卡片欄位值和來源標記，OEP 將其引用定位標為已發布卡片欄位，並從指向同版卡片的 link／linklist 建關係。原始 AEP 封裝留在 SQLite blob。只有原格式具備的欄位、來源與關係可映射，未隨交換檔匯出的獨立 evidence／關係表仍待實際樣本確認。

AEP Wiki 接受本機發布 manifest 與明確指定的 `--wiki-root`，核對批准標記、raw／decisions／content 雜湊。支援名稱可唯一解析的 wiki links，引用位置用半開區間 `#chars=start-end` 表示原 Markdown 的 UTF-16 字元單位偏移。輸入 `vault_ref` 僅留作原始封存資料，轉換路徑使用指定的本機目錄。

固定版格式對照如下。 [AEP BI snapshot](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/bi_knowledge/python/aep_bi/cards/snapshot.py) · [AEP Wiki publication](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/llm_wiki/python/aep_wiki/host/knowledge_publish.py) · [AEP Wiki digest](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/src/knowledge/evolution.py)

## 匯入與回復

以下命令使用 repo 的合成資料。實際快照由 owner 提供本機路徑，匯入前依 D01／D02 確認資料與 Gateway 使用權限。預設只允許本機查閱中繼資料，授權合成或已核准內容送模型時才使用 `--allow-model`。

```powershell
npm run knowledge:migrate -- --dry-run tests/fixtures/knowledge/aep-bi.synthetic.json
npm run knowledge:migrate -- --dry-run tests/fixtures/knowledge/aep-wiki/manifest.json --wiki-root tests/fixtures/knowledge/aep-wiki
npm run knowledge:migrate -- --import tests/fixtures/knowledge/aep-bi.synthetic.json --allow-model
npm run knowledge:migrate -- --rebuild
npm run knowledge:migrate -- --backup
```

乾跑與匯入皆先在記憶體 shadow 驗 schema、內容、索引和輸入 hash。乾跑輸出完整的來源、卡片、關係、段落對照表，驗證失敗會以欄位／列位址回報。實際匯入於同一交易寫入 blobs、FTS5 與目前發布指標。SQLite 存於 `OEP_DATA_DIR/web/knowledge.sqlite`，預設資料目錄為 Windows 的 `%LOCALAPPDATA%/OEP`。重新打開知識頁會載入更新後的快照。

備份是獨立一致的 SQLite 檔。驗回復時可在另一個空的 OEP 資料目錄建立 `web` 子目錄，把該份備份置於 `web/knowledge.sqlite`，再用該目錄啟動並比較版本及來源。保留原資料目錄可回到原先狀態。

## Gold set 評分與原始紀錄

`npm run knowledge:benchmark` 對兩個核准 alias 各跑完整 48 題。原 Phase 0 的 48 個問題與標註保持固定，額外放入 10 段近似料號、空欄提示及不同領域的合成證據，合計 40 段。可答題計分需含標註答案並引自標註來源，引用另從存放的發布版重查位置、版本、內容與 hash。不可答題遇到通訊錯誤記為失敗，符合拒答狀態才計入。任何將無答案題的引文呈現為答案，都記為關鍵無支持。模型回覆及重試細節留在忽略的 `.phase0/knowledge-gold-*/`，共用報告只留合成結果。
