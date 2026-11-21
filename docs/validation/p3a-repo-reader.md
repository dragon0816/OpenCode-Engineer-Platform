# Phase 3a　AEP 知識儲存庫資料夾

## 格式依據

本次唯讀檢視 AEP 公開提交 `c9961b2d0d66eef3892375213ce305883ebde960`，以獨立的 TypeScript 實作讀取資料格式。以下路徑與名稱皆為結構名稱或合成範例。 [儲存庫設計 §4–§7](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/docs/phases/KNOWLEDGE_REPO.md) · [紀錄實作](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/src/knowledge/repo/repository.py)

| 依據 | 可確認事項 |
|---|---|
| Owner 回報的結構 | BI 儲存庫位於 SharePoint 同步的資料夾。頂層可見 `applications/`、`library/`、`cards/`、`commits/`、`publish/`、`published/`、`schemas/`、`tags/`。`applications/segment-a/` 內有 `profile/`、`skills/`、`sources/markdown/`、`tools/`。`library/kind-x/` 內有對應的 profile、skills、sources、tools。library 另可有 `skills/`、`skill-review/`。 |
| 公開設計與程式 | `repo.json` 可標示格式 `aep.knowledge.repo/v1`、`id`、`title`、`type`（`bi`／`wiki`）。`commits/author-a/1.json` 是 `aep.knowledge.commit/v1`，帶 commit ID、repo、author、seq、clock、base、schema、操作和引用檔的路徑及雜湊。`tags/tag-a.json` 把 tag 連到 commit。`publish/author-a/1.json` 列出發布事件。 |
| 推論 | `cards/` 的 Markdown 可是發布時產生的檢視。`published/` 的 SQLite 可是某版 BI 的 materialized state。只拿到頂層清單時，仍須以發布紀錄與 SQLite 結構確認每個檔案的用途。 |
| **UNVERIFIED** | Owner 實際資料夾的 `repo.json`、tag／發布檔各欄位、SQLite 版本及表結構、快照完整性、是否有外部來源尚未同步、OneDrive 檔案隨選的原生行為。 |

## 解析發布版本

1. 檢查本機資料夾及可選的 `repo.json`。沒有該檔時從已發布紀錄取 repo ID，從 SQLite 表辨識 BI。路徑必須留在指定資料夾內，連結會被拒絕。
2. 讀取 `publish/<author>/<seq>.json`。在公開版，格式為 `aep.knowledge.publish/v1`，帶 `repo`、`author`、`seq`、`clock`、`tag`、`commit`、`at`。以 `(clock, author, seq)` 最大者為準。author 依字元排序，seq 為整數。重發舊 tag 可以撤下較新的內容。`tags/<tag>.json` 的名稱與 commit 必須和本次發布一致。
3. 若發布紀錄附 `snapshot`，採用其 `path`（必須在 `published/` 內），核對記錄的 `sha256` 和可選的 `bytes` 或 `size`。沒有 descriptor 時嘗試 `published/<tag>.sqlite`，並標明哪些完整性欄位可驗。`snapshot: null` 表示發布時沒有連結快照。AEP 固定版寫入的是 path 和 SHA-256，大小欄位是 OEP 容許的擴充。 [BI 卡片模型 §6.2](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/docs/phases/BI_CARD_MODEL.md#62-publishedtagsqlite-d6) · [快照寫入實作](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/bi_knowledge/python/aep_bi/cards/vault.py#L1371)
4. OEP 以唯讀、immutable SQLite URI 開檔，停用擴充載入，檢查 SQLite 完整性及讀取前後檔案雜湊。含未清空的 rollback journal 或 WAL 的檔案會被拒絕。選中的 tag 缺失、發布檔半同步、摘要或大小錯誤時回報問題，既有 OEP 版本繼續服務。沒有發布紀錄時顯示「沒有發布版本」。AEP 自身可重播到 `head`，此資料夾讀取器只匯入可辨識的發布快照。 [公開發布行為](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/src/knowledge/repo/repository.py#L1676)

## BI SQLite 版型

固定版的發布檔由指定 commit 重建。固定版 BI materializer 設定 `PRAGMA user_version=14`。owner 的實際已發布快照見到 `user_version` 8 與 9（舊版 8 的 `evidence` 少 `assessment` 欄），讀取器不依賴特定版號，只記錄實際值。下表列出與匯入直接相關的欄位，較早快照可缺少部分表或後加欄位。 [SQLite 建表](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/bi_knowledge/python/aep_bi/cards/store.py#L86) · [BI Vault §9](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/docs/phases/BI_VAULT.md#9-agent-discovery-and-readers)

| 表 | 格式與 OEP 映射 |
|---|---|
| `cards` | `id`、`entity_type`、`canonical_key`、`name`、`version` 成為卡片的識別碼、類型、鍵、標題與版本。原始 blob 另保有建立／更新等欄位。 |
| `fields` | `card_id`、`field`、JSON `value`。欄位出處保留 `kind`、`ref`、`by`、`at`。 |
| `history` | `seq`、`card_id`、`field`、舊值／新值、變更出處與舊 evidence 等可用欄位存為歷史。 |
| `relations`、`relation_evidence` | 原始關係 ID 及 from／to 卡片、類型、狀態、出處、欄位、範圍、備註等隨世代保存。關係的證據保留 `relation_id`、`basis_card_id`、`reference_id` 及可用的立場／評估。 |
| `evidence` | 核心欄位為 `seq`、`card_id`、`field`、`source_id`、`source_name`、`locator`、`excerpt`。參照 ID、立場、擷取執行 ID、依據、時間及評估存在時一併保存。來源修訂取 locator 中的 `rev`，缺省時記錄發布 commit。引用保留定位並重算 excerpt 的 SHA-256。空摘錄和 inference 不加入 FTS5。長摘錄按字元切段，保有半開區間的位置。 |
| `meta` | `schema` 鍵可攜帶字串版號。OEP 保留它、SQLite `user_version` 及表欄位，作為正規化快照的結構描述。 |

原公開版另有搜尋用 SQLite，包含 `card_text`、`chunk_text` 的 FTS5、卡片索引及來源版號表。OEP 自行索引快照證據並保存原始 SQLite bytes。獨立的 `aep-bi-dataset-snapshot/1` JSON/gzip 是另一種交換格式，其現有轉換器仍可用。 [搜尋索引格式](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/bi_knowledge/python/aep_bi/cards/search_index.py#L53) · [JSON/gzip 交換格式](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/feature_plugins/bi_knowledge/python/aep_bi/cards/snapshot.py#L1) · [既有操作](p3a-knowledge.md)

**UNVERIFIED** 項目包括實際快照的 locator 變體、原始文件與 Markdown 的版本、位置和雜湊能否逐一對齊，及 Wiki 儲存庫的發布成品。讀取器保存 SQLite 內的證據並驗 excerpt hash，原文來源檔未讀取。AEP 文件記載舊快照可保留後來撤回的來源摘錄，OEP 此版未重播來源撤回紀錄。Wiki 資料夾可檢查結構，Wiki manifest 匯入走既有入口。 [AEP 撤回限制](https://github.com/dragon0816/agentic-engineering-platform/blob/c9961b2d0d66eef3892375213ce305883ebde960/docs/phases/BI_CARD_MODEL.md#62-publishedtagsqlite-d6)

## 本機操作

```powershell
npm run --silent knowledge:inspect -- "C:\example\repo-a"
npm run knowledge:migrate -- --import-repo "C:\example\repo-a"
npm run knowledge:migrate -- --restore-repo repo-a tag-a@example-generation
```

檢查只輸出頂層資料夾、遞迴副檔名計數、發布解析狀態、SQLite 檔案大小與編號、表／欄位名稱、列數及 SQLite 版本。它不輸出 SQL 資料列、內文、原始資料夾路徑、作者或實際 tag。選中的 SQLite 以編號連到遮蔽標籤 `resolved-tag`。`--show-names` 在本機加印原始 tag、SQLite 及錯誤的相對路徑。使用 `--silent` 可省略 npm 把命令列引數原樣印出的橫幅。檢查遇到錯誤仍輸出已知結構並以非零狀態結束。

CLI 匯入預設保留在本機。Web 從左側知識庫展開「從儲存庫資料夾匯入」，輸入本機完整路徑後可檢查或匯入。只有明確勾選授權，或在 CLI 傳入 `--allow-model`，該版本的證據才可由 Ask 傳給模型。庫、內容、FTS5 及目前指標在 OEP SQLite 同一交易切換。舊世代保留，可用報告的 vault 與 revision 回復。讀取限額為 JSON 2 MiB、SQLite 128 MiB、BI 各表 10 萬列及檢查 5 萬筆檔案項目。

## 2026-11-21　Owner 實際資料夾驗證（去敏摘要）

Claude Code 在 owner 授權下，對 owner 本機的已發布資料夾做了結構檢查與一次影子匯入（寫入暫存資料目錄，未啟用模型使用，來源資料夾未改動）。實際資料與名稱不進 repo。

- 格式判定為 `aep.knowledge.repo/v1`、類型 BI。最新發布紀錄解析出發布版本，檔案雜湊驗證通過。發布紀錄未記錄檔案大小，故 `sizeVerified=false`，不是損壞。
- 3 個已發布 SQLite，版號 8 與 9。14 張表與欄位名稱皆在預期範圍，`field_states` 與 `relation_evidence` 為空表，這兩張表沒有真實資料可驗。
- 匯入成功，匯入後 `integrity_check` 為 ok，卡片數與資料夾內卡片檔數一致。英文與中文詞（含繁體中文）的 FTS5 檢索皆有命中。
- 仍為 **UNVERIFIED**：OneDrive 檔案隨選在原生環境的行為、真實資料的 Ask 品質、v8 快照的匯入（本次只匯入目前選用的版本）。
