# Phase 3G 知識外掛與知識庫設計

2026-11-23｜設計提案｜OEP Windows 11 單人工作台

## 1. 交付範圍與責任

擁有者於 2026-11-23 確認，**知識外掛是建置工具，知識庫是它產生的成品**。安裝 BI Knowledge 後，使用者從外掛頁選來源，經轉檔、擷取、驗證、人工審核與發布，得到可獨立安裝的版本。助理從 OEP 核心讀取已發布知識庫，取得有引用的問答。移除建置外掛後，同一助理仍可查詢已發布的本機版本。3G 驗收聚焦流程接通，內容選擇、卡片品質和題目判準由 BD／PM／AE 負責。

首版支援本機安裝團隊簽章外掛、本機發布、匯出與重裝知識成品。日後 3F 對接 OEP 已選用的公司 Share Platform，沿用同一成品驗證與安裝入口。3G 共用 3E 的 Skill／Workflow 定義、能力庫與受控執行介面。3I 先於 3E 的排序及個別助理選擇模型來源的決議照用。建置送模型與發布版問答各自授權。公司 Gateway 依既有資料政策使用，外部 coding agent 僅能取得全來源均經確認為公開的輸入。 [Phase 3 需求 §§4.4–4.5、5、10–11](../PHASE3_REQUIREMENTS.md) · [決策紀錄](../DECISIONS.md)

## 2. AEP 參考流程與 OEP 缺口

AEP 以 `861d0c0ca0813073f3944d4aff88818980beff2a` 為準，查閱 `c9961b2..861d0c0`。第二輪主要合併點為 `de0c5e14`。表內區分該段提交的變更和 HEAD 已有的版本機制。AEP 根目錄未提供 LICENSE，本輪只記錄行為，後續以 OEP 自有契約、程式、介面及合成資料獨立實作。 [AEP 比較範圍](https://github.com/dragon0816/agentic-engineering-platform/compare/c9961b2...861d0c0) · [第二輪合併](https://github.com/dragon0816/agentic-engineering-platform/commit/de0c5e14) · [OEP 既有差距盤點](../AEP_FEATURE_GAP_ANALYSIS.md)

| 步驟 | AEP HEAD 的行為與依據 | OEP 的現況與本期補足 |
| --- | --- | --- |
| 1. 選庫與來源 | 選工作領域與寫入目的地，加入本機文件、表格或可用的收件匣來源。轉檔保留圖片，模型圖片描述可在背景另成修訂。BI bot 把連結或檔案歸入領域，可定時收集、提醒，產出止於待審。第二輪可設定收集時間、按領域回答純問題，並補上公開 X 連結的擷取分支。 [轉檔](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/convert.py) · [Inbox 處理](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/inbox/process.py) · [圖片](https://github.com/dragon0816/agentic-engineering-platform/commit/27945d46) · [收集時間](https://github.com/dragon0816/agentic-engineering-platform/commit/cff3e8fa) · [Bot 問答](https://github.com/dragon0816/agentic-engineering-platform/commit/382f74dc) · [公開連結](https://github.com/dragon0816/agentic-engineering-platform/commit/f169cc60) | 已有 BI 相容收件、補件、原 bot 通知與排程共用領取。缺 Web 的建庫、批次來源、轉檔和分段進度。沿用現有公開連結限制，本期優先本機來源。 [BI service](../../apps/adapter/src/bi/service.ts) · [派送](../../apps/adapter/src/bi/dispatch.ts) · [排程](../../packages/knowledge/src/jobs/scheduler.ts) |
| 2. 選 schema 與方法 | schema 有草稿與正式版本。可按需針對來源提出 schema 建議；第二輪把 schema、判讀規則與程序集中至匯入入口，內建方法可唯讀查看，主要操作頁移除原先的進階協作入口。 [Schema 版本](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/schema_versions.py) · [集中匯入](https://github.com/dragon0816/agentic-engineering-platform/commit/dfa6d025) · [Schema 建議](https://github.com/dragon0816/agentic-engineering-platform/commit/d4a09951) | 已有審核 schema／版本與快照驗證；模型提案仍按指定欄位為單一來源產生一張卡。缺建立空工作庫時可選的版本化卡型、關係、固定擷取方法與試跑。 [Store](../../packages/knowledge/src/store.ts) · [提案](../../apps/adapter/src/http/review.ts) |
| 3. 擷取卡片 | 結構化表格可走規則，非結構化來源可分段交模型。依卡型、鍵、欄位和證據產生候選，檢查引文、重複及與既有卡片的差異。第二輪支援每次最多四段並行、取消、重啟後標示未完成與只重試缺段。 [擷取](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/extract.py) · [候選運算](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/runs.py) · [並行與復原](https://github.com/dragon0816/agentic-engineering-platform/commit/179cdc7e) | 已有來源雜湊與逐字引文驗證、`Candidate`／`ChangeSet`、工作租約與效果台帳。補版本化分段、規則轉換、同鍵候選、局部失敗與重啟對帳。 [候選素材化](../../packages/knowledge/src/ingest.ts) · [Store](../../packages/knowledge/src/store.ts) |
| 4. 暫存 | 擷取批次、各段進度和候選先在 staging 留存；候選可指向新卡或既有卡的待決修改。已確認的卡可匯入工作資料。 [Staging](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/staging.py) · [匯入已接受項目](https://github.com/dragon0816/agentic-engineering-platform/commit/f27c3428) | 已有待審草稿與編輯版本。補建置批次、可復原的段落收據，以及以一個明確基底彙整新卡、更新與關係。 |
| 5. 審核與驗證 | 第二輪把新卡、既有卡修改和處置狀態放在同表，可逐筆或批次決定，可查看欄位差異與證據。擁有者明確啟動的自動執行可串接轉檔、擷取、接受並匯入工作資料、跑測試。收件匣自動收集停在待審。Benchmark 可比較工作副本與發布版。 [審核合併](https://github.com/dragon0816/agentic-engineering-platform/commit/bf395d70) · [決定及重開](https://github.com/dragon0816/agentic-engineering-platform/commit/e1397210) · [自動執行](https://github.com/dragon0816/agentic-engineering-platform/commit/de16b41e) · [Benchmark](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/host/bi_bench.py) | 工作台已可比較、編輯、核准、拒絕與發布，品質頁支援發布版本題集。補同批審核及同一候選雜湊的試跑報告。OEP 自動建置到待審為止，沿用兩次人工操作。 [審核 API](../../apps/adapter/src/http/review.ts) · [品質頁](../../apps/web/src/knowledge-quality.js) |
| 6. 發布 | Vault 工作變更可提交、推送、為版本加 tag，再由人確認發布。發布路徑產生快照、記錄與摘要警告。第二輪沿用 Vault 機制，調整分享入口的位置；另有受平台權限及審核控制的 BI dataset 發布分支。 [Vault 發布與提交](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/vault.py) · [分享入口](https://github.com/dragon0816/agentic-engineering-platform/commit/c12221be) · [平台發布 API](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/host/bi_cards_api.py) | 核准與發布分開，快照、FTS、目前指標和通知意圖同一交易，有回退。補首次建庫的完整入口、獨立成品匯出與安裝。 |
| 7. 版本化 Vault | 儲存 commit、tag 與發布紀錄，依發布順序選版，保留歷史。讀取端偏好已發布的快照；AEP 部分未發布庫會讀已推送 head。 [Repository](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/src/knowledge/repo/repository.py) · [Vault 讀取](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/cards/vault.py) | 已支援匯入 BI repository 的選定發布快照與 provenance。補本機工作庫與唯讀成品的明確生命週期。OEP 助理入口只看有有效發布指標的版本。 [Repository reader](../../packages/knowledge/src/repository.ts) · [Launcher](../../apps/launcher/src/knowledge.ts) |
| 8. 搜尋與問答 | 知識入口列可問庫與狀態，BI 的對話工具／助理查詢可回傳來源和版本資訊。BI 與 Wiki 的入口各有可用條件。 [Vault 選擇](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/host/bi_vaults_api.py) · [BI 對話工具](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/host/bi_cards_tools.py) · [Knowledge binding](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/src/host_runtime/knowledge_binding.py) | 已有 FTS5、瀏覽、Ask、引用 verifier、助理綁定、會話及 MCP 範圍。補套件與版本來源的識別，並驗證移除建置外掛後這些核心路徑仍可運作。 [Ask](../../packages/knowledge/src/ask.ts) · [Knowledge MCP](../../apps/adapter/src/opencode/knowledge-mcp.ts) · [Web](../../apps/web/src/knowledge.js) |

AEP 的 BI 與 Wiki manifest 指向 in-process Python feature。Host 從內附或已安裝清單找出有效項目，已安裝內容先核對已登錄雜湊，再匯入 Python。Feature 可貢獻啟動、HTTP 路由、頁面片段、工具、Skill、收件及套件安裝等掛勾。這些掛勾說明要接通哪些功能。OEP 採宣告式註冊與宿主控制的工作程序契約。 [Host 合約](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/src/host_runtime/features.py) · [已安裝驗證](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/src/plugins/in_process.py) · [BI 註冊](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/bi_knowledge/python/aep_bi/feature.py) · [Wiki 註冊](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/llm_wiki/python/aep_wiki/feature.py)

## 3. OEP Plugin v1（R9）

### 3.1 格式、信任與權限

- `.oepplugin` 為 ZIP。根目錄為 `manifest.json`、`manifest.sig`、`payload/`。manifest 必填 `format: oep.plugin/v1`、全域唯一的 `id`（例如 `oep.bi-knowledge`）、SemVer `version`、`publisher`、`oepCompatibility`、`signingKeyId`、`permissions`、`components`、`files`。`files` 覆蓋每個 payload 檔的相對路徑、byte 長度與 SHA-256。`manifest.sig` 存 Ed25519 簽章，簽署有固定用途前綴的 UTF-8 manifest 原始 bytes。宿主拒絕重複 JSON 鍵和未知 v1 欄位，避免解析歧義。
- `components` 包含 `skills`、`workflows`、`pythonWorkers`、`dataSchemas`、`pages`、`panels`、`reviewTypes`、`collections`，各元件 ID 以外掛 ID 為命名空間。宣告需通過對應格式、版本、參照、資源和權限驗證。Skill／Workflow 引用 3E 相同庫及逐助理授權。Collections 只註冊 schema、唯一業務鍵、讀寫範圍及是否需審核，寫入由 OEP 交易驗證並記錄來源助理與 run。
- `permissions` 列宿主已知操作、允許的資料範圍、可用 worker 及模型／來源 broker。從「能力 → 外掛」顯示版本、簽章結果與申請權限。安裝所接受的上限，仍與工作或助理授權、資料分級、模型授權取交集。新權限由擁有者在升級預覽確認。套件內 Skill 的啟用受 §10.6 逐助理設定及現行 Skill 數量警示管理。
- 正式簽章僅由 OEP 開發團隊發行。建議用不可匯出的專用硬體金鑰，指定發行維護者經雙人核准簽署，CI 產生待簽 manifest 和摘要，發行台帳保留版本、雜湊、key ID 及簽署者。私鑰留在發行流程，OEP 安裝包只內建公鑰／允許 publisher 與 key ID。輪替先隨 OEP 更新加新公鑰並安排重簽，遇失竊隨受信任 OEP 更新撤銷；每次啟用、重啟及執行前依目前本機信任表檢查，撤銷在更新送達後生效。擁有者只能安裝團隊提供的套件及維護庫內容；沒有外掛作者入口、手動信任金鑰或略過驗證開關。CI 使用只存在隔離測試宿主的測試信任根。

### 3.2 安裝、啟用、升級、移除與回退

建議以 `<OEP_DATA_DIR>/plugins/packages/<id>/<version>/` 保存不可變版本，`plugins/staging/<operation-id>/` 保存同磁碟的驗證暫存。`web.sqlite` 由宿主管理安裝清冊、目前版本、啟用狀態、manifest 雜湊及操作 journal。建置工作資料放在 `<OEP_DATA_DIR>/plugin-data/<id>/<workspace-id>/` 的受管暫存／輸入產物區，工作狀態和跨功能引用仍由宿主的固定資料庫保存。正式知識庫、FTS 及證據存於 `knowledge.sqlite`，發布成品只依核心內容契約。

1. **安裝。** 從本機選檔，未來可經受管下載。驗簽、相容範圍、publisher、每檔長度及雜湊；檔案清單需精確對應 ZIP。限制壓縮前後大小、筆數及比率，拒絕額外檔、目錄穿越、絕對路徑、Windows 保留名／ADS、大小寫碰撞、重解析點及 hard link。確認後寫 journal，解壓到受管暫存，重驗後同磁碟移入版本目錄，再以清冊交易啟用。啟用前的暫存與已落地未啟用版本可在啟動時依 journal 回收或續作。相同 ID／版本／雜湊為重試，異雜湊的同版本拒絕。
2. **升級。** 先保留舊版、核對權限與遷移計畫；暫停該外掛的新工作，等待短工作結束或依現行規則取消，核對工作、審核、通知效果。截取建置狀態快照並做 shadow 遷移。核對結果後在可恢復的操作中切換目前版本和 registry generation。每個 run 固定 package digest、schema 及 generation，舊回合的結果無法跨代交付。重新啟用前驗證已安裝檔案，實際執行的 worker 程式及檔案需和驗證的 bytes 相符。
3. **移除。** 停止外掛工作接單、撤銷票券，待效果可確認後卸下頁面、路由、能力及審核操作。已發布的知識庫仍由核心供 Assistant Ask，原綁定保留；BI 的未發布草稿暫停，可在重新安裝相容版本後續作。保留過去審核、排程、收件及收據，已提交的通知由既有 outbox 完成。建置資料的永久刪除是另一次明確操作。版本目錄確認無使用者後可刪，保留一個上次有效版供回退。
4. **回退。** 只選仍通過信任與相容性檢查的版本。若資料格式可讀直接切換；否則把前版建置狀態從一致備份恢復，保留新版未發布工作供人工對帳。建置狀態和共用的歷史或發布列以獨立投影或相容轉換隔離，外掛回退禁止回寫已發布資料、助理綁定、共享收件台帳及已提交的效果。若無法驗證相容性，外掛維持停用，核心查詢繼續。外掛回退與知識庫「改用較早發布版」是兩個獨立操作。

### 3.3 頁面、工作程序與遷移

- 左欄「主功能」在啟用成功後掛載 `pages`，預設一個「BI Knowledge」入口。中央區呈現建置清單、步驟與進度；右側按需開啟 schema、卡片差異、證據或驗證結果。通用「知識庫」頁繼續提供已發布成品的瀏覽及問答，「審核」頁以 `reviewTypes` 接收待審項目。原網址與正在使用的審核連結導到對應宿主視圖；重新啟用可打開暫停的建置。頁面與面板由宿主元件、雙語字串、明確的 action ID 組成；宿主處理配對、CSRF、授權、鍵盤、窄版及焦點。 [三區藍圖](../GUI_REDESIGN_BLUEPRINT.md) · [現有殼層](../../apps/web/src/app.js)
- Python 走受控 worker。沿用工作簿的固定入口、最小環境、限額與收據模式，以及 Windows Job supervisor 的成員核對、時限與整組終止；v1 加入受限 Windows 身分、ACL、經驗證的網路拒絕及工件核對。由宿主釘選 Python 版本和已驗證、可離線解包的相依，無 shell、安裝時 pip、繼承憑證或任意 socket。Job Object 負責程序生命週期，讀取範圍靠身分及 ACL，網路由 OS 隔離驗證。允許讀取固定版本程式及當次輸入副本，只寫當次輸出區；模型與核准來源的外部請求由宿主 broker 執行。票券固定外掛、助理或擁有者、工作庫、工作 ID、操作、時限與輸入雜湊。Worker 交回有界資料、檔案和安全狀態碼，由宿主核對後才寫暫存或審核，不能直接開資料庫或呼叫發布。任一隔離條件無法證實，該 worker 不啟動。 [工作簿執行與收據](../../apps/adapter/src/runs/receipt.ts) · [Windows Job](../../scripts/phase0/windows-job.cs) · [Phase 3B 授權及工作範圍](PHASE3B_MULTI_AGENT_DESIGN.md)
- OEP 擁有核心 DDL、備份、交易與遷移執行。外掛團隊擁有領域 schema 和版本轉換，提交隨版簽章的遷移計畫（from／to、相容讀取範圍、確定性轉換 ID 與結果摘要）；OEP 以內建的受控遷移步驟驗證及提交，外掛不能提供在宿主 DB 直接執行的 SQL。首版所有 SQLite 路徑沿用現有的固定位置，允許清單按 DB／`user_version` 增列新空表或從舊版推導的精確種子。外掛清冊、BI 歸屬與建置新表要與遷移同切片加入檢查。對帳比對既有欄位的列雜湊、發布與索引雜湊、來源、排程／審核／通知關聯，未知非空表或路徑變型拒絕；外掛檔案以相對路徑及完整 bytes 比對。OEP 整體升級仍依 Phase 5 的一致備份與 journal，外掛安裝切換在一般啟動後執行，避免維護階段把外掛產物當任意 DB。 [固定路徑](../../scripts/windows/snapshot-paths.mjs) · [資料遷移](../../scripts/windows/data-migrations.ts) · [快照對帳](../../scripts/windows/data-snapshot.mjs) · [升級允許清單測試](../../tests/contract/upgrade-allowlist.test.ts)

## 4. BI 遷移與成品生命週期（R10）

### 4.1 資料所有權

| 資料 | 儲存與所有者 | 主要關聯 |
| --- | --- | --- |
| 外掛與建置 | 宿主清冊保存安裝版本與啟用權；BI 外掛提供建置頁面、schema、來源轉檔、擷取 worker、工作流程、差異及專用審核畫面。宿主保存工作庫、來源版本、工作、候選及審核交易。 | 工作庫用穩定 `vault_id`；來源以 ID／SHA-256 識別。建置記錄 `plugin_id`、`plugin_version`、package digest、schema digest、輸入版本、目前發布基底和 run ID。 |
| 已發布成品 | OEP 核心管理本機 `vaults`、不可變 `publications`、正規化內容與 evidence blob、FTS5、版本指標、分級及模型授權。外掛可提交審核輸入，由宿主發布服務驗證與寫入。 | `vault_id` 為庫身分，`revision` 為不可變版本 ID，`snapshotHash` 綁定內容，`parentRevision` 串接本機歷史。建置者 ID／版本只作 provenance，可安裝及可查詢條件由核心格式及權限決定。 |
| 助理權限 | 宿主沿用 `agent_knowledge_reads(agent_id, vault_id)`。勾選只為該助理授予讀權，核心在每次請求解析到有效版本，查詢開始後固定 revision 與 hash 並重驗。 | 助理預設跟隨該庫目前的有效發布版。工作庫寫入、BI 收件目標與建置執行都走各自授權。版本停用時保留綁定並顯示暫不可用。 |

`.oepkb` v1 為本機匯出／安裝的資料封裝。manifest 包含格式／核心 reader 版本範圍、發行身分、來源命名空間、`vault_id`、`revision`、父版本、發布時間、正規化 snapshot 雜湊、必要檔案長度／SHA-256、schema 參考與存取／分級標記。內容為可由核心解讀的 schema 資料、卡片或 Wiki 段落、關係與可查核的引用／證據；索引由安裝端重建。成品只提供知識問答所需資料，執行元件、原始私有收件、工作草稿、通知台帳和憑證留在建置端。匯出預覽列出證據會隨封裝帶出。成品完整性使用內容雜湊；本機手動安裝以擁有者確認來源為信任起點，雜湊可核對損毀但不證明出版者身分。Share Platform 版再驗已驗證的發行者、權限及平台提供的保護性 metadata，具體對應由 3F 定案。外掛 Ed25519 簽章的信任政策不轉移給成品。

建議在 `knowledge.sqlite` 加宿主管理的 `knowledge_workspaces`、`build_runs`、`build_parts` 及來源關聯，初建只配置工作庫 ID，等第一次發布才建立核心 `vaults` 列。工作可依序為 `draft → building → awaiting_review → approved → published`，並有 `failed`、`cancelled`、`paused` 等可恢復狀態。成品讀取面只依核心發布與安裝狀態，`vaults` 可在沒有相應工作庫或建置者清冊列時獨立存在。資料庫關聯禁止以外掛移除觸發刪除發布或綁定。

### 4.2 從內建 BI 轉為外掛

- 先抽出宿主端的建置註冊介面，把舊 BI service、來源派送、既有 ingest／審核和頁面包成第一方內建相容註冊。查詢、發布交易、通道台帳、Job claim 及通知留在宿主；建置決策與 UI 逐切片掛到團隊簽章的 `oep.bi-knowledge` 清冊。舊 Web、Telegram、排程及交辦入口都呼叫同一個啟用中的 BI handler。
- 有舊 BI 狀態的升級可由 OEP 發行包提供已簽章的相同版本供接管。先維持相容橋，驗簽及對帳成功才把既有工作與審核歸屬一次性掛到相同外掛 ID。遷移採附表或相容欄位，沿用 `vault_id`、助理 ID／綁定、舊 revision／blob／來源 hash、工作鍵、租約、待處理通知和 review ID；同一時間只由一個 handler 寫入。失敗回到已知的相容 handler，重新執行遷移得相同結果。接管成功後記錄完成，使用者主動移除時不再啟用內建相容橋。
- BI 專職助理保留原工作區、會話、收件與交辦來源。外掛停用期間仍保存未處理的收件，UI 明示建置暫停；安裝回相容版本以原業務鍵對帳與續作。舊已核准待發布項目隨建置暫停，已發布項目與已提交的 outbox 效果繼續有效。既有多助理隔離、模型席位、來源分級及授權不隨遷移擴大。 [多助理設計](PHASE3B_MULTI_AGENT_DESIGN.md) · [BI 歸屬](../../packages/knowledge/src/bi/ownership.ts) · [助理設定](../../apps/adapter/src/http/agents.ts) · [審核 API](../../apps/adapter/src/http/review.ts)

### 4.3 操作流程

1. **建立工作庫。** 在 BI 頁選空庫＋本機來源，或「從 repository export 建立」。檢查目錄型態及資料分類，分配新 `vault_id`，收錄來源識別、雜湊、可開啟位置及來源版本，並以唯讀開啟來源。匯入按 `repo.json`、`publish/`、`tags/` 找發布紀錄與對應 `published/` 快照。重用 `importRepository` 底下的 `readRepository`／`readBiSnapshot` 與既有路徑、大小、SHA-256 驗證，將讀出的標準化快照送入建置暫存；不直接呼叫會註冊發布的 `KnowledgeStore.import`。新庫保留上游 repo／commit／tag／摘要與上游卡、來源 ID 關聯。摘要缺項如實標示，快照遺失、損毀或格式不符時提供安全原因碼並可改選有效來源。仍保留舊的「匯入已發布版本」動作給直接安裝用途。
2. **轉檔與建置。** 選已啟用的 schema 版本與擷取方法。一般本機來源優先 UTF-8、Markdown、CSV，可按需啟用受控文件轉檔，再依頁／段／列建立證據定位；先以表格固定欄位規則及受控 Gateway 擷取兩種方法接通流程。repository 匯入的卡片、關係與證據走無模型的正規化驗證與候選建置，同樣進審核；既有快照可重用來源定位，缺原文或定位的項目顯示證據不足，不能冒充可引用段落。擷取固定基底、schema 和方法，來源格式錯誤可逐件補正。規則與程式由團隊發布，擁有者可調整已允許的欄位對應及建置參數。按庫序列化變更，用 `vault_id + baseRevision + schemaDigest + methodVersion + sourceHashes` 衍生去重鍵，記錄每段狀態與結果 hash。取消終止工作並阻擋遲到結果，重啟用有效收據補缺段，效果不明先對帳。限額以 3B 及現有 Gateway、來源與 worker 限額的較小者為準。
3. **驗證與審核。** 檢查欄位型別、必要鍵、重複／刪改、關係端點、逐字證據和分類。中央審核列表有新卡、修改、拒絕與缺證據項目；右側查看前後差異、來源與定位。可對固定候選做合成題試跑，報告綁候選雜湊，編輯後標示過期。自動建置可跑到有效待審批次。擁有者選擇採用項目並核准，再對核准內容執行「發布」。草稿、待審、僅核准的內容只在工作台建置與受控預覽可見。
4. **發布與退回版本。** 重用 `publishReview` 的父版本檢查、穩定效果鍵、原子發布與通知。一次交易驗核准的 edit／schema digest、重算有效候選、寫不可變快照及 FTS5、切 `vaults` 指標、記 receipt 及通知意圖；基底已變更則重算差異並重新審核。首次可從無 active publication 的工作庫發布。發布後工作庫可繼續以當前版本為基底建置。回退只切至仍驗證通過的版本，保留所有已發布歷史；首次發布退回時解除有效指標並保留歷史。通知重送沿用原 review key 與目的地。
5. **安裝成品。** 本機發布即在本機知識目錄登錄。可匯出 `.oepkb` 後在另一個沒有 BI 外掛的 OEP 安裝。未來 Share Platform 下載接同一入口。由核心解封並驗檔、限制格式、核對內容與來源範圍，按可信來源命名空間映射 vault ID，遇同名不同來源要求區分並保留現有綁定。相同版本與摘要重試只回既有回執；相同身分／版本異摘要拒絕。更新先在宿主重建／驗證索引，再原子啟用；模型權預設關閉，逐發布版本由擁有者授權。已安裝的外部庫可唯讀使用；若要改編，從該版本建立新工作庫並保留來源關聯。
6. **綁定並問答。** 在助理的「知識庫」選已發布庫；由宿主寫 `agent_knowledge_reads`。對話的明確 `/ask` 或會話 Ask 選一庫，核心 `KnowledgeAsk` 檢索該版 FTS5、使用與會話一致且獲准的 Gateway 模型及同次 evidence verifier。聊天 MCP 共用範圍與 verifier，由模型選用。引用帶 vault、revision、snapshot hash、卡／段落 ID、來源版本、引文定位及證據雜湊；按需顯示受管證據，避免直接開啟來源絕對路徑。查詢前及回傳前重驗綁定、索引、版本、模型授權和分類，無證據、無授權、版本切換或引文無法逐字驗證時顯示具體狀態。跨庫檢索留待另案，避免在不同庫之間隱式擴大讀權。 [現有版號與證據契約](../../packages/knowledge/src/ask.ts) · [助理資料庫](../../apps/adapter/migrations/003_agent_ledger.sql) · [本機路由](../../apps/adapter/src/main.ts)

### 4.4 後續 Knowledge Wiki

AEP Wiki 把轉檔後來源交給 sandbox，先規劃頁面、再套用變更，追蹤衝突與證據，最後由確認動作產出新發布版。OEP 已可讀正規化 Wiki 快照，也有草稿與捨棄路徑；資料夾 repository reader 目前僅支援 BI 匯入。後續 `oep.knowledge-wiki` 重用 3G 安裝、工作與發布合約，提供文件轉頁、綱要與變更比較、來源段落、連結／循環／引用檢查、衝突待審，並輸出核心的資料型 `.oepkb`。首版以基底不符要求人工重新檢視，之後評估合併。驗收要在移除 Wiki 外掛後仍可由同一助理引用發布頁。 [AEP Wiki pipeline](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/llm_wiki/python/aep_wiki/knowledge/pipeline.py) · [衝突](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/llm_wiki/python/aep_wiki/knowledge/conflicts.py) · [發布](https://github.com/dragon0816/agentic-engineering-platform/blob/861d0c0/feature_plugins/llm_wiki/python/aep_wiki/host/knowledge_publish.py) · [OEP 舊格式轉換](../../packages/knowledge/src/convert-aep.ts)

## 5. 端到端驗收設計

| 擁有者步驟 | 可重複驗收判準 |
| --- | --- |
| 安裝 BI 外掛 | 全新 Windows 測試資料根開始，確認「能力」顯示受信任 publisher／版號、左欄出現 BI 頁、一般「知識庫」仍可開啟。改一個 payload byte、相容範圍不符、未知 key、路徑穿越均拒絕，清冊與導覽維持原狀。 |
| 建立 BI 知識庫 | 從 repository export 匯入到新的工作庫。以來源摘要及卡、關係、證據的結構數量核對來源至候選，並驗建置進度與 review ID。合成案例另用一個新來源走轉檔和規則／模型擷取。重送、取消、崩潰後續作只產生一次有效工作效果。助理挑選庫時看不到此工作庫。 |
| 核准及發布 | 先驗未核准不能發布，已核准尚不能搜尋。擁有者發布後核對 revision、摘要、索引與指標同一交易；重試回同一版號。發布 v2、回退到 v1，核對版本、索引及歷史。模擬中途故障時仍只有原版可查。 |
| 助理引用與測答 | 從助理設定綁定已發布庫，經該助理的會話 Ask 回答。對一題已知有證據、一題無證據及未綁定助理驗證；有證據題的回覆需通過同次逐字引文檢查，點引用能追到該版的卡與證據。確認假造引文及撤權後遲到回覆不外洩。 |
| 移除建置工具再查 | 移除 BI 外掛、重新啟動，BI 建置頁消失；同一助理、同一 `vault_id` 與 revision 仍能答且引用可開啟。再把該版的 `.oepkb` 安裝到第二個從未安裝 BI 外掛的隔離資料根，明確開啟該版模型權並綁定測試助理，核對版本與證據摘要一致。重裝外掛後可續作原工作庫。 |
| 舊資料升級 | 使用已提交的歷史 DDL fixture。核對既有庫、分類、助理綁定、待審、排程、BI 收件和未送通知；測接管重跑、切換前後中斷與回退，舊來源不重擷取、通知不重發。 |

- **合成 CI。** 沿用 repo 已提交的 [`syntheticRepository` fixture](../../tests/fixtures/knowledge/repository.ts)，在測試暫存目錄產生小型等形 export；已有 `repo.json`、`schemas/`、`cards/`、`commits/`、`tags/`、`published/`、`publish/`、`applications/`、`library/` 和兩個標籤的 SQLite。實作驗收切片在同一個 fixture 補 `REPO.md`、最小 schema 與一筆有唯一可驗證引文的來源及對應卡；生成快照與雜湊於測試執行期，合成定義提交到 repo。保留原有讀取器 fixture 的壞檔用例，以新測試所需的乾淨輸出作為正例。使用僅測試信任根簽發的套件及合成 Gateway，從正式 Web／HTTP 路徑跑安裝至問答，再加未安裝 builder 的成品接收端。
- **擁有者樣本。** 手動 Windows 驗收以 `OEP_MARKET_INTEL_DIR` 指向提供的本機 export。環境變數未設定或指定資料夾不存在時顯示 **SKIP**，已存在但資料無法匯入時記 **FAIL** 及安全的失敗階段。樣本含 `REPO.md`、`repo.json`、`schemas/`、`cards/`、`commits/`、`tags/`、`published/`、`publish/`、`applications/`、`library/`。以唯讀根與獨立且位於 repo 外的暫存 `OEP_DATA_DIR`、OpenCode／瀏覽器 profile、loopback port、mutex 及 Gateway stub 跑驗收。記錄只保留結構計數、步驟狀態及去敏原因碼；不提交樣本、不複製入 repo、不截圖、不引用原文、不留路徑／檔名／題目／模型回覆於 log、報告或測試產物。自動測答由測試在記憶體挑選現有可驗證證據，stub 回傳合法與非法引用，保留布林判準。日後若加跑真模型，由 BD／PM／AE 提供本機題目並依適用資料政策使用公司 Gateway。測後清理自建的隔離工作區，不碰樣本根或安裝中的 OEP。

## 6. 實作切片、風險與待決事項

| 順序 | 交付 | 完成判準 |
| --- | --- | --- |
| 3G-1 | 共用外掛清冊、簽章檢查、原子安裝與版控、主功能頁註冊及升級對帳。先用無資料的合成外掛。 | 安裝、變造拒絕、升級、移除、回退與崩潰恢復。雙語空殼、鍵盤及右側面板可驗證。 |
| 3G-2 | 核心 `.oepkb` 匯出／安裝、發行身分、引用與模型授權，用既有合成發布版驗證。 | 沒裝 builder 的兩個隔離 OEP 都可匯入及綁定。駁回壞摘要、惡意路徑、版本／來源碰撞及越權。 |
| 3G-3 | BI 內建相容橋、第一方簽章套件、審核類型註冊、Telegram／工作／交辦派送、舊資料接管。 | 歷史 DDL fixture 的識別、發布內容及通知完全對帳。移除／重裝 BI 後舊的已發布庫仍可查，未發布工作可續作。 |
| 3G-4 | 建庫、repository 至建置暫存、版本化 schema、受控 Python 轉檔／擷取、候選及人工發布。 | 合成 export、原始合成來源均抵達發布；票券、隔離、重試、晚到結果、核准和發布邊界通過。本機樣本按條件驗收擁有者流程。 |
| 3G-5 | 建置批次的驗證報告、重試診斷與完整驗收；後續另交付 Knowledge Wiki 外掛及 3F 遠端傳輸。 | 合成 CI 重跑與本機 owner 流程完整可查，第一版與更新版引用可核對。Wiki、Share Platform 各以同一獨立成品安裝契約驗收。 |

- **資料與台帳。** 多 DB 的狀態、舊 pending 效果和版本指標都需要保持一致。用相容附表、固定業務鍵、舊版備份及 journal 做 crash／replay 驗證，移交中維持單一寫入者。
- **輸入格式。** 舊 export 的發布記錄、SQLite 版本、證據欄位可能有落差。沿用唯讀讀取器的版本分支、摘要驗證與索引核對，以結構診斷說明未支援的版本，不回退到猜測工作資料內容。
- **Windows 隔離與發行。** Python 相依、ACL、Job 及網路隔離要在公司 Windows 環境實證；暫停個別不可安全執行的 worker，repository 的確定性匯入仍可用。簽章撤銷只有在信任更新送達後生效，發行團隊應有金鑰輪替與失竊換版演練。
- **證據與模型權。** 建置運作成功只能證明資料接通和引文驗證。內容充分度由 BD／PM／AE 判定。建置與問答依各自模型授權，資料版本、分級及來源變更須重新校驗。

### 擁有者待決

1. **正式簽章由誰保管，既有安裝如何拿到套件？** 建議指定兩名 OEP 發行維護者管理硬體金鑰及發行台帳。新安裝由能力頁選團隊提供的本機檔；升級包附簽章版本供既有 BI 自動接管，從乾淨安裝驗收手動安裝。
2. **首輪真模型驗收要用哪個 Gateway 模型，由誰核定題目？** 建議機械驗收先走合成 Gateway，BD／PM／AE 各選本機有證據與無證據題，擁有者再選公司 Gateway 上已核准的模型，逐版本確認模型使用。保留結果狀態，樣本題目與答案留在驗收當下。
3. **Share Platform 第一輪要開放哪些知識庫與受眾？** 建議先採明確選擇發布版本與指定受眾的手動送審，預設僅本機發布。由平台維護者確認權限、發行者身分、版本及撤回對應後，再啟用遠端傳輸。

