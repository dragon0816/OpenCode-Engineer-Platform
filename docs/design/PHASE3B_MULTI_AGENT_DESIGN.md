# Phase 3B／3B2 多助理與交辦設計

2026-11-22 · 設計草案，待審閱與擁有者核准 · 程式基準為 main 的 `db4ff99`

## 1. 交付邊界

3B 交付主助理、專職助理、建立精靈、各自的工作資料夾、知識授權、Telegram 綁定與內建「BI 資料處理」。3B2 交付主助理交辦、專職端執行紀錄、結果通知與附加資料。此處的 3B 與 3B2 指 2026-11-22 定義的多助理計畫。較早交付的 BI 匯入、審核、發布與排程是此設計的基礎。

3B 須有 Web、通道和既有 BI 工作共用的寫入協調。3B2 加入交辦優先級及其計費。3C 再擴充使用者定義的觸發、排程和結果目的地。3D 接上重要會話與審核後寫入的資料集。3J 接入 WhatsApp，3I 再執行外部代理的資料分級檢查。3A 的模型選擇是本設計的實作基準。 [Phase 3 需求](../PHASE3_REQUIREMENTS.md) · [決策紀錄](../DECISIONS.md) · [架構決策](../ARCHITECTURE_DECISIONS.md)

## 2. 資料模型

所有新表均為 SQLite `STRICT`。下表以 `T`、`I`、`B` 表示 `TEXT`、`INTEGER`、`BLOB`，`?` 表示可空，其餘均為非空；時間為 UTC epoch 毫秒，布林用 `I CHECK IN (0,1)`，列舉用 `CHECK`，JSON 以 `T CHECK(json_valid(...))` 儲存並在寫入時驗證結構。新助理、工作資料夾、通道帳號、工作項目、交辦與檔案使用伺服器產生的 UUID；內建識別碼使用 `main`、`bi` 及下述固定舊資料對照。既有 ID 一律保留。同一 DB 開啟 foreign keys，參照採 `RESTRICT`。跨 DB 以固定來源與鍵查驗，無有效參照時不啟用；版本遷移及啟動均執行對帳。

### 2.1 助理與授權

| 表與所在 DB | 欄位與限制 |
| --- | --- |
| `agents` · `web.sqlite` | `id T PK, role T`（`orchestrator`、`specialist`），`builtin_key T?`（唯一），`state T`（`active`、`archived`），`name T, introduction T, instructions T, avatar B?, avatar_mime T?, default_model_id T?, reply_locale T, config_revision I, created_at I, updated_at I`。`reply_locale` 為 `zh-TW` 或 `en`。頭像兩欄同空或同時有值，沿用 PNG/JPEG、90 KiB、1024×1024 上限。名稱、簡介、指示上限沿用 80／500／4000 字元。內建初值可顯示語言檔名稱，自訂名稱照原文。 |
| `agent_workspaces` · `web.sqlite` | `id T PK, agent_id T FK, layout T, relative_root T, display_name T?, is_default I, classification T, created_at I`。`layout` 為 `managed`、`legacy_default`、`legacy_secondary`。每助理恰一預設工作資料夾由建立交易保證，部分唯一索引防重；同時提供 `UNIQUE(id,agent_id)`。`relative_root` 唯一且由伺服器解析。 |
| `workspace_read_folders` · `web.sqlite` | `workspace_id T FK, folder T`，聯合主鍵。使用者透過工作台明確選檔才附加，絕對路徑只存在受控設定。 |
| `agent_knowledge_reads` · `web.sqlite` | `agent_id T FK, vault_id T`，聯合主鍵。授權對象是已安裝且有發布版本的庫。模型使用仍須經發布版本的授權及索引檢查。 |
| `agent_write_targets` · `web.sqlite` | `agent_id T FK, target_kind T, target_id T, write_mode T`，前三欄為聯合主鍵。`target_kind` 為 `knowledge`、`bi_intake`、`collection`；`write_mode='proposal_only'`。3B 僅啟用內建 BI 的已核准目標及受限收件庫。 |
| `agent_capabilities` · `web.sqlite` | `agent_id T FK, kind T, capability_id T, enabled I`，前三欄為聯合主鍵。`kind` 為 `skill`、`workflow`、`mcp`、`plugin`。3B 管理既有 MCP 的助理授權，通用安裝與啟用介面留在後續。舊 MCP 授權另以 `workspace_mcp_grants(workspace_id T FK, server_id T FK)` 限定工作資料夾，生效權限取交集。 |
| `agent_trigger_settings` · `web.sqlite` | `agent_id T PK FK, message_enabled I`。3B 的有效綁定預設開啟訊息，3C 可在此管理。Web 手動對話獨立於此開關。3C 的排程以 `agent_id` 作外鍵。 |
| `session_ownership` · 兩個會話 DB | `session_id T PK FK web_sessions, agent_id T, workspace_id T, origin T`（`web`、`channel`、`delegation`、`schedule`），`channel_account_id T?, conversation_key T?, binding_revision I?`。只有 `channel` 填通道三欄。`web.sqlite` 以 `(workspace_id,agent_id)` FK 驗擁有關係，`telegram-chat.sqlite` 從中央設定查驗；對兩庫建立 `(agent_id,origin,session_id)` 索引。 |

主助理必為 `main`，以 `CHECK` 綁定角色與啟用狀態，部分唯一索引限制主助理最多一筆，遷移種入一筆，SQL trigger 拒絕刪除及修改其身分，開庫檢查恰一筆。`bi` 的內建身分與執行模式固定；一般專職助理可封存，交易檢查沒有未結工作與有效通道，保留舊會話與紀錄供擁有者查閱。助理預設模型 `NULL` 表示跟隨全域預設。明確選擇須存在於 3A 的已選清單，送件以已套用清單與新設定的交集為準；被移除的模型在下一則訊息改用有效的助理預設、再回退至全域有效預設，顯示提示並記錄實際 ID。新清單尚未套用且無可用交集時，提示先套用，保留會話。

`web_sessions.agent` 的 `inspector`／`workbook` 是 OpenCode 執行設定名稱，與 OEP 的 `agent_id` 各自保存。對話仍由 OpenCode 保存；側欄及資料 API 用 OEP 歸屬查詢，並保留舊表的標題、隱藏旗標、註記、回覆、附件與 run。`WebStore.modelSelection()` 是 3A 選擇來源，`WebStore.preferences()`、`appearance()`、`sessions()` 是舊資料來源。 [WebStore](../../apps/adapter/src/runs/web-store.ts) · [Ledger](../../apps/adapter/src/runs/ledger.ts)

### 2.2 通道、工作、交辦與來源

| 表與所在 DB | 欄位與限制 |
| --- | --- |
| `channel_accounts` · `web.sqlite` | `id T PK, provider T, account_fingerprint T?, credential_ref T UNIQUE, allowlist_ref T, agent_id T FK, handler T, state T, binding_revision I, created_at I, updated_at I`。`handler` 為 `chat` 或 `bi_intake`。有外部身分即以 `UNIQUE(provider,account_fingerprint)` 擋重複。`state` 為 `unverified`、`enabled`、`disabled`；待驗證列仍有助理，且禁收發。 |
| `channel_cursors`、`channel_inbound` · `telegram.sqlite` | 前者 `account_id T PK, checkpoint T, updated_at I`。後者 `account_id T, event_key T, conversation_key T, binding_revision I, agent_id T, received_at I, first_attempt_at I?, status T, payload T?, attempts I, due_at I, work_id T?, reason_code T?`；`status` 為 `pending/handed_off/handled/rejected/failed`。主鍵 `(account_id,event_key)`，待派送依 `(status,due_at,account_id)` 索引。 |
| `channel_outbound` · `telegram.sqlite` | `account_id T, effect_key T, conversation_key T, binding_revision I, agent_id T, payload T, state T, attempts I, due_at I, provider_receipt T?, reason_code T?`；主鍵 `(account_id,effect_key)`，同目的地按入列順序送。`state` 沿用 `pending/sending/sent/indeterminate/failed`。 |
| `channel_conversations` · `telegram.sqlite` | `account_id T, conversation_key T, binding_revision I, agent_id T, session_id T`；主鍵 `(account_id,conversation_key,binding_revision)`，對應 Telegram 對話台帳中的本機會話。改綁後用新版號開新會話。 |
| `agent_work_items` · `web.sqlite` | `id T PK, agent_id T FK, source T, source_key T, effect_class T, state T, enqueued_at I, ready_at I, expires_at I?, lease_id T?, lease_until I?, run_store T?, run_id T?, schedule_ref T?, payload T, reason_code T?`。`source` 為 `direct`、`delegation`、`schedule`；`effect_class` 為 `write`、`verified_read`；`UNIQUE(source,source_key)`、待派索引 `(agent_id,state,ready_at,enqueued_at,id)`，每助理只允許一筆寫工作持有未釋放的執行權。 |
| `delegations`、`delegation_events` · `web.sqlite`（3B2） | 前者 `id T PK, work_id T UNIQUE FK, parent_store T, parent_session_id T, parent_run_id T, target_agent_id T FK, child_session_id T?, child_run_id T? UNIQUE, request_key T, request_hash T, status T, reserved_requests I, reserved_tools I, reserved_ms I, used_requests I, used_tools I, elapsed_ms I, created_at I, finished_at I?, result T?, destination T`。`UNIQUE(parent_store,parent_run_id,request_key)`，索引 `(parent_store,parent_session_id,created_at)`。後者 `delegation_id T FK, sequence I, at I, state T, reason_code T?, metrics T?`，前兩欄為主鍵，事件只附加。 |
| `delegation_request_keys` · `web.sqlite`（3B2） | `parent_store T, parent_run_id T, request_key T, delegation_id T FK`，前三欄為主鍵。留存重複內容的額外鍵，重播同鍵時也能檢查內容；`delegations` 另以 `UNIQUE(parent_store,parent_run_id,request_hash)` 限制同一父回合的同一內容。 |
| `delegation_files`、`delegation_notices` · `web.sqlite`（3B2） | 前者 `delegation_id T FK, file_id T, direction T, source_file_id T, name T, bytes I, sha256 T, classification T, provenance T`，主鍵 `(delegation_id,file_id)`；`provenance` 存受控來源 ID 及雜湊。後者 `delegation_id T FK, kind T, state T, effect_key T UNIQUE, created_at I, seen_at I?`，主鍵 `(delegation_id,kind)`；Web 投影及通道寄送重播共用此穩定鍵。 |
| `bi_source_ownership` · `telegram.sqlite` | `source_id I PK FK bi_sources, agent_id T, origin T, account_id T?, conversation_key T?, binding_revision I?, delegation_id T?, work_id T?, review_id T?`。`origin` 為 `telegram`、`web`、`delegation`、`legacy`。新來源的正整數 ID 由 SQLite 保留給既有／相容收件；新通道路徑及 Web／交辦以獨立 UUID `source_key T UNIQUE` 及負整數內部列鍵，畫面只顯示舊正號或公開 `source_key`，避免與舊 Telegram update 撞號。 |
| `bi_job_ownership`、`review_provenance`、`bi_publication_ownership` · `knowledge.sqlite` | 分別為 `(job_id T PK FK ingest_jobs, agent_id T, work_id T?, origin T)`、`(review_id T PK FK reviews, agent_id T, origin T, source_key T?, run_id T?, delivery_destination T?)`、`(publication_id I PK FK publications, agent_id T, review_id T? FK reviews)`。BI 管理歸屬與提案作者／來源分開保存。 |

`run_store`／`parent_store` 為固定 Web 或通道台帳鍵，無法指定檔名。交辦 child 另用 Web 台帳內的新 session 和 `Ledger` run；工作項目和交辦是領域索引，OpenCode 的完整訊息、工具活動仍是執行紀錄的來源。跨 DB handoff 先存意圖，對方以穩定鍵去重，再確認同一筆；程序恢復時以該鍵對帳，未知外部效果保留待核對。`telegram.sqlite` 保留舊 spool 作歷史與回退比對，新的 spool 成為新處理路徑。 [Run ledger](../../apps/adapter/src/runs/ledger.ts) · [TelegramInbox](../../apps/adapter/src/telegram/inbox.ts) · [KnowledgeStore](../../packages/knowledge/src/store.ts)

### 2.3 升級與回退

1. 維護模式用既有快照與 `prepared` journal。`scripts/windows/migrate-data.ts` 在任何 adapter、scheduler、poller 活動前完成同一資料根的整組遷移，依兩個會話庫、知識庫、Telegram 舊表的存在狀態重跑。各庫各自交易，最後以版本與跨庫對照檢查允許切換，失敗沿用同一份備份回退。Web 兩庫現為 `user_version=2`，Telegram 和 knowledge 為 `1`。3B 首次遷移分別升至 `3`／`2`／`2`；後續切片的 DDL 隨各庫版本演進，`Ledger` 保留非 Web DB 的版本規則。Telegram 的舊 router/scheduler 表在相應版本遷移集中管理，舊庫缺表時依歷史契約建立空表。
2. 從 Web `web_preferences`、`web_appearance` 種入 `main`。助理預設模型初始跟隨原有 `web_model_settings`，日後可指定。無舊資料採原 UI 預設，`zh-TW` 為通道初值。主題與密度仍是全域外觀。`default` 與 `secondary` 成為 `legacy-default`、`legacy-secondary`，皆歸 `main`，前者預設。舊 `ChatService.projectRoot()` 的根分別是 `web/`、`web/secondary/`，遷移保留原 `sessions/`、`model-work/`、`artifacts/` 下的實體路徑與上游 location。缺專案列按現行 `COALESCE` 歸預設，包含隱藏會話、未結／失敗 runs、原檔及預覽。唯讀外部資料夾與 MCP 專案範圍照原資料夾對照。新專職助理與 `bi` 使用 `web/agents/<agentId>/` 下同類子資料夾，保留每會話子目錄。
3. 主助理初始讀權取升級當時已安裝且已發布的知識庫；工具開關沿用 `web_knowledge_settings.toolbox` 與每會話的停用記號。Telegram Main 原 `/ask` 的既有庫授權獨立於工具開關。新增庫需明確綁定。有設定有效 BI `target` 時給 `bi` 該庫的讀權及提案權，無目標時保留每件收件專用的 BI 庫行為。擁有者可另選其他已發布 BI 庫供 `bi` 查詢。
4. 為 `main`、`bi` 建立固定 Telegram 帳號 ID `telegram-main`、`telegram-bi`。保留舊 `telegram_binding` 指紋供啟動核對，同 bot／同使用者沿用現有 User-scope 憑證名稱、游標、topic 映射、舊 `turnId()` 和 outbox effect keys。維護程式不取憑證，也不連外。舊對話鍵可直接從帳號及 topic 派生，啟動驗舊指紋及私聊允許者才啟用該鍵。同一筆歷史 spool 的完成、失敗、嘗試和時限都映射至新列，處理中寄送於正常啟動轉待核對。換 bot 或 owner 必須建立新帳號設定或先作擁有者確認的復原，避免把舊 cursor 或待送資料交給不同對象。
5. `bi_sources`、既有 BI 工作、審核與版本以附表歸到 `bi`。用既有 `telegram-bi-<id>`、`ingest_effects` 和既有索引關聯能證明的 Telegram 來源；其他 BI 舊審核以舊人工或來源不明標記。依候選與已發布的 `kind=bi` 判定管理歸屬，Wiki 保持原路徑。保留 `bi_config`、待審／核准待發布狀態、草稿編號、發布與回復歷史、現行指標、blob 與通知意圖。舊列完整保存；已送歷史沿用去重鍵，未送照原目的地處理。 [TelegramRouter](../../apps/adapter/src/telegram/router.ts) · [BI 遷移與發布](../../packages/knowledge/src/ingest-migrations.ts)

`scripts/windows/data-snapshot.mjs` 的 `reconcileUpgrade()` 現只允許已列入名單的新空表。依檔名與明確的舊→新版本分支補 `webAdditions`、`knowledgeAdditions` 和 Telegram 的空表清單；有基礎資料的新表另走具名驗證，逐筆重算內建列、session owner、spool、引用庫與 BI provenance 的唯一鍵、來源欄值、筆數與雜湊，並驗證 `foreign_key_check`。時間等新欄位以固定遷移值或明確範圍比對。保留既有欄位摘要、發布雜湊／內容計數及非 DB 檔案雜湊的嚴格比較。對帳只建立原本缺少的受管 DB 時，驗證那份固定路徑及預期初值。回退差異報告納入新收件、寄件、工作、交辦和通知表。復原仍成套還原程式、資料與 OpenCode profile。

以 `db4ff99` 取既有 SQLite DDL，新增固定合成 fixture，沿用 `tests/fixtures/upgrade/web-before-model-selection.sql` 與 `tests/e2e/maintenance-fixture.ts` 的方式。fixture 保留當時索引、欄位與缺表狀態，含兩個工作區、原有 Web／Telegram ID、工作資料夾檔案、舊 bot 指紋、等待／未確定寄送、BI 中途收件、編輯及發布版本。合約與安裝升級／回退共用資料種子。 [升級對帳](../../scripts/windows/data-snapshot.mjs) · [遷移入口](../../scripts/windows/migrate-data.ts) · [維護操作](../OPERATIONS.md)

## 3. 執行環境與隔離

### 3.1 採單一 OpenCode runtime

保留一個 Windows launcher／Job Object、受保護的 loopback upstream、固定 OpenCode profile 與一組已選模型。`startRuntime()` 建 relay、知識服務和 supervisor，`supervise()` 用啟動設定登錄 provider／MCP，`startAdapter()` 依忙碌狀態協調重啟，`openCodeEndpoint()` 驗證 listener 歸屬並加 upstream 認證。每助理一個 runtime 會引入多份 profile、啟停與資料遷移，還須重做現有單一實例鎖及故障復原；同一 Windows 使用者啟動多個 process 也不會自動隔離檔案。Phase 3B 採共用 runtime 加 OEP 授權、完整 session 權限與受控檔案工具。 [Launcher runtime](../../apps/launcher/src/runtime.ts) · [Supervisor](../../apps/launcher/src/supervisor.ts) · [重啟流程](../../apps/launcher/src/web.ts) · [OpenCode client](../../apps/adapter/src/opencode/client.ts)

- OEP 以 `agent_id`、`workspace_id`、`origin`、模型 ID、指示與 config revision 組合各會話的執行設定。OpenCode 的 `inspector`／`workbook` 保留為兩個固定 primary 模板，助理設定獨立保存。`createSession()` 驗證回傳的 agent、location、provider 與 model，舊會話驗證原歸屬與 location 後，沿用同一 upstream ID。指示沿用 `ChatService.execute()` 的當回合內容機制；權限完全由伺服器指定。
- 每次送出回合前更新整份 deny-by-default permission set。作用域為該助理、工作資料夾、執行來源與該次工作，並取當前授權與已套用設定的交集。`ChatService.execute()` 目前針對工作簿會更新成單一 edit 規則、之後清空；改為同一份權限建構器，含工作簿的 OEP 寫入工具，確保其他 deny 持續生效。拒絕 shell、任意網路、原生跨路徑檔案工具與 OpenCode 子代理。`waitForOutcome()` 保留拒絕上游額外權限請求的行為。
- 在建立與實際派送重驗模型、助理狀態與權限。指示、預設模型、語言及精靈新增的助理沿用既有模板，下一回合即可生效。更改已登錄的 MCP 定義或已選模型清單採現有閒置重啟流程；先停止新派送、待執行中的租約與工具結束，持久佇列及通道 outbox 可繼續等待而無須清空。撤銷授權立即使新工具呼叫失效；有敏感權限被撤銷的執行同步要求中止並對帳。保留原有本機配對、Host／Origin／CSRF 保護。
- `startKnowledgeRuntime()` 現用 `startKnowledgeMcp()` 提供全域預設模型的 `ask`。改由 OEP scope broker 依已驗證回合身分提供 scope-aware `ask`。Web 對話的知識查詢入口、Telegram `/ask` 及 MCP 工具共用同一檢核，核對助理與庫綁定，再走 `KnowledgeAsk.ask()`、已發布版本、版本模型許可與 evidence verifier。回答使用該次已核准模型並回傳引用，讀取固定的查詢版本，草稿、BI 私人收件、歷史未啟用版本均無模型接點。獨立「知識庫」頁面的擁有者操作保留，助理無法透過工具使用。
- 工作簿、檔案與已授權的自訂 MCP 都從同一工具允許清單導出。`custom-mcp.ts` 的 transport 驗證、已知工具名及個別 deny 保留，`appliesToProjects` 遷成工作資料夾授權。3B 的既有遠端工具只有在命中助理及舊資料夾授權、驗證個別工具名稱並符合遠端 HTTPS 邊界時才可由 OEP broker 轉送；輸入沒有 OEP 憑證或內部路徑，轉送保留既有固定目的地的 DNS/TLS 與禁止重新導向規則。既有任意 stdio 與本機／私人網路 MCP 定義和憑證參照照常保留，可在設定檢視與執行原有明確連線測試。自動提供給助理須先有可驗證的執行隔離，初版標示暫停，且啟動器不自動連線或啟動這些伺服器。這項升級行為須由擁有者裁決。

派送器接手目前 Web 與 Telegram 各有一個 `ChatService.queue` 的情況。`startGateway()` 的 `setTurnBoundary()` 及 `gatewaySince()` 現為 runtime 共用，全域只允許一個模型 turn 或 BI 領域模型請求持有派送權，避免覆蓋截斷、工具限制和稽核。不同助理的工作可同時接單，準備、搬檔、通知等不呼叫模型的步驟可在各自執行權下並行。3B2 保證同時交辦不同專職助理時，各自有獨立生命週期；首版模型步驟輪流使用同一 runtime。未來在可靠關聯模型請求到各 run 後再開模型並行。 [ChatService](../../apps/adapter/src/http/chat.ts) · [Session API](../../apps/adapter/src/opencode/sessions.ts) · [對帳](../../apps/adapter/src/opencode/reconcile.ts) · [模型 relay](../../apps/adapter/src/opencode/gateway.ts) · [知識 MCP](../../apps/adapter/src/opencode/knowledge-mcp.ts) · [知識 runtime](../../apps/launcher/src/knowledge.ts) · [知識問答](../../packages/knowledge/src/ask.ts) · [自訂 MCP](../../apps/adapter/src/runs/custom-mcp.ts)

### 3.2 工具呼叫歸屬與檔案安全

啟動時登錄同一份 OEP 內建 MCP，沿用 `startKnowledgeMcp()` 的回圈位址、只有預期 Host、拒絕 Origin、短生命期程序憑證、輸入大小及方法限制。現有 MCP `tools/call` 只有工具參數與程序級憑證。派送器為每次嘗試產生獨立的隨機 `policy_nonce`，加在當次使用者訊息的受控尾段，由 relay 核對後從模型請求及工作台投影剝除。由 relay 根據**本機正在執行的 run 與該 nonce** 簽發一次性票券；只有符合當前回合、工具名與 allowlist 的真正模型工具回傳才可取得。票券綁定本次啟動、upstream session、run、工具名、call ID、正規化參數雜湊及短有效期。所有工具執行皆查票、再次驗當前 scope，在同一操作內消耗一次；只有同一已驗證且仍有效的請求才可重讀既有收據。工具參數內的角色、工作根、上下文 ID 或憑證欄位由伺服器拒絕。結束、中止或重啟撤銷該 run 的票券，遲到的呼叫無法取得新 run 的權限。

實作接點是 `startGateway()` 已完整緩衝的 SSE completion 及 JSON completion。relay 核對送往模型的工具描述與 allowlist，也拒絕 completion 中清單外的工具呼叫；兩種 completion 皆先重組工具 arguments、核對 schema，再於送回 OpenCode 的完整 arguments 加入由 relay 所有的傳輸欄位。該欄位在對 OpenCode 的 schema 中保留，由 relay 從送往模型的 schema 移除，並於所有後續模型上下文、Web 工具投影及診斷剝除；模型主動填入該欄一律拒絕。模型工具以外的受控入口（例如 `/ask`、BI 收件）由已驗證的伺服器 dispatcher 直接建立 scope。契約 gate 用固定 OpenCode v2.3.2 驗證兩種 completion、工具 schema、`session.update()` 的覆蓋／順序、延遲重送及隱藏工具名。若固定版不接受或無法隔離，阻擋新工具路徑啟用，回到設計審閱。

路徑從 DB 管理的邏輯 ID 解析。舊預設的物理根是 `web/`，實際只允許它的指定 `sessions`、`model-work`、`artifacts` 下的本會話／run 子目錄，任何機密、其他助理與 profile 的根都不藉父目錄繼承授權。維持每會話目錄；如需持久工作檔，以工作資料夾下單獨的受控檔案區供該助理的明確檔案操作，舊直接對話的附件、生成物與 transcript 保持 session 私有。檔案工具以不可猜的附件／產物 ID，或在該 run 的輸出區受驗證的相對名稱操作，拒絕越界、絕對／UNC、ADS、reparse point、symbolic／hard link、Windows 進階名稱及大小寫正規化的碰撞。沿用 `scopedPath()`、`checkDirectory()`、`openWorkspaceFile()` 的路徑、handle、身分與 SHA-256 核對，以及 `validateProjectFolder()`／`foldersOverlap()` 拒絕受管或重疊根。寫入用 Windows 同根暫存、exclusive create、開檔後比對 handle 的最終位置與連結、原子 rename 及驗證 manifest；固定版若無法拒絕競態改接的路徑，寫入功能需先補可驗證的 handle-based helper。舊唯讀資料夾以使用者選檔後的驗證副本交給指定會話。 [Windows workspace 路徑與身分](../../apps/adapter/src/runs/workspace.ts) · [唯讀資料夾](../../apps/adapter/src/runs/project-folders.ts) · [附件](../../apps/adapter/src/runs/attachments.ts)

實作期用獨立 Windows 測試根量冷啟動與閒置切換耗時、常駐記憶體與 Job 成員數；比較 2、5、10 個助理設定下的 builder／MCP 枚舉、平行接單時首回覆和各優先級等待、大小檔案核驗／複製成本、SQLite claim 與重啟對帳時間。另比較模型序列與可靠 per-run 關聯後的並行容量，必要時才比較多 runtime 的記憶體、啟動與停止成本。以既有單助理路徑為比較基準，本設計未量測。

## 4. 通道與 BI 專職助理

### 4.1 通用介面

```text
InboundEnvelope { accountId, eventKey, conversationKey, receivedAt, kind,
                  text?, attachmentRefs?, providerReceipt? }
OutboundMessage { accountId, conversationKey, effectKey, locale, kind,
                  text, fileRefs? }
ChannelTransport {
  verifyAccount(credentialRef, signal) → identity + capabilities
  receive(account, checkpoint, signal) → batch + nextCheckpoint
  fetchAttachment(account, attachmentRef, limit, signal) → checkedBytes
  deliver(account, message, signal) → sent(receipt) | rateLimited(retryAt)
                                       | indeterminate | failed(reasonCode)
}
```

`receive` 表示提供下一批經驗證的事件，來源可為 polling 或 relay。通道適配器做身分允許清單、來源格式、媒體能力、大小及目的地驗證。核心在同一 spool 交易寫 `(account_id,event_key)` 去重列與 checkpoint，拒件只留原因，不保存未授權內容。交易提交後通道才能確認 receipt／offset。快照綁定包含 `agent_id`、`binding_revision` 及目的地。工作佇列以穩定 `source_key` 接單；通道在領到相同 work ID 後標記已移交。接單逾時與回合排隊期限分開。寄送依 `effect_key` 去重，確定限流按指定時間重試，回覆不明續留 `indeterminate`，只在擁有者確認後重送。純唯讀命令保留獨立處理通道，但仍須經助理 scope 與派送規則。

每個 bot 帳號有且僅有一個 `agent_id`，助理可綁多個 bot。新增／修改以 Telegram `getMe` 驗證提供方帳號，使用 canonical ID 的雜湊做 DB unique check，token rotation 仍是同一帳號。並行儲存取第一筆成功交易，第二筆回 `CHANNEL_ACCOUNT_IN_USE`，顯示既有助理。設定及接收共用 binding admission lock，改綁需顯式確認，停舊 poller 並等待或由擁有者處理舊版待收、待送與工作；恢復 poll 前再驗帳號與 revision。歷史事件依舊快照查閱，舊 destinations 絕不重新路由。外部 poll conflict 顯示狀態與停止重複積極搶收。退回與修復亦須用原帳號驗證身份。

### 4.2 Telegram 第一個實作

`startTelegram()` 目前按 Main／BI 硬接兩組 `TelegramPoller`；改為從已驗證的帳號註冊每帳號一個 poller。沿用 `TelegramApi.call()/file()` 的有界讀取、長輪詢、私人 chat、允許使用者與 topic。現有 `TelegramInbox.admit()/complete()` 的 durable handoff、`TelegramPoller.deliver()` 的不確定寄送語意移到通用 spool。`TelegramRouter.handle()` 根據帳號綁定與 handler 分流；`chat` 處理所屬助理的一般對話及有權限的 `/ask`，`bi_intake` 交給內建 BI service。對話鍵含受驗的 chat／topic，舊鍵可經由舊 owner 指紋映射到同一對話；既有 Main 與 BI 憑證參照及新 bot 的 User-scope 憑證參照由 adapter 讀取。Telegram 回覆跟隨助理 `reply_locale`，驗證錯誤及狀態回覆用通道語言檔，模型回合帶該語言指示。模型輸出與狀態摘要遵守 Telegram 長度上限。

3J 的 WhatsApp 需 Meta 商業帳號及可接受 webhook 的公開 HTTPS relay。relay 驗證握手與簽章、 durable admit 後才回應提供方，再用本機 OEP 主動建立的認證連線交付、確認 checkpoint。以提供方電話帳號和訊息 ID 對應 account／event key，媒體仍經有界下載與既有 allowlist；對話窗口、核准範本及送件回執由適配器標明能力。OEP 仍僅在 loopback 監聽。relay、資料保留與憑證由 3J 選定，這兩期只交付 Telegram。 [Telegram service](../../apps/adapter/src/telegram/service.ts) · [Router](../../apps/adapter/src/telegram/router.ts) · [Inbox](../../apps/adapter/src/telegram/inbox.ts) · [Poller](../../apps/adapter/src/telegram/poller.ts) · [WhatsApp 需求 D3](../PHASE3_REQUIREMENTS.md#7-擁有者決議2026-11-22)

### 4.3 BI 資料處理

內建簡介為「接收使用者傳來的資料，處理成 BI 卡片並送審」。把 `TelegramRouter.intake()/supplement()/stage()` 的領域流程抽至 BI service，Telegram、工作台直接對話及 3B2 交辦共用。Telegram 傳連結、檔案或文字時先保留原始資料，經既有核准來源 HTTPS 檢查、有界下載與 UTF-8 驗證。需補件時顯示原接單 ID 與原因；非文字原檔保留，沿用補 UTF-8 文字的流程。直接對話支援以收件 ID 查狀態與補件，Telegram 同帳號／對話可用 `/status`、`/supplement`，工作台使用私有來源連結。對話模型僅能讀取該會話擁有的來源或使用者明確交給它的來源；通道補件也須比對原目的地與綁定。

針對已配置的 BI 庫，`proposeReview()` 查當前父版與 schema、使用助理有效模型、沿用小型來源限制並核對每個欄位引文。資料不足或引文不符則保留為待補件。無目標時沿用每筆獨立 `intake-*` 庫及 `enqueueBi()/runBi()` 的人工送審流程；伺服器只允許由該筆收件生成的庫與 schema，無任意庫的寫權。`review_provenance` 跟同一筆 pending review 或已有 ingest effect 原子入帳，`bi_sources` 對帳後轉 `awaiting_review`。若審核基底在處理中改變，停止並提示核對，保留原稿與來源。BI 的模型、通道與交辦憑證只拿到 proposal service；核准、拒絕、發布、回復及匯入權限由工作台的擁有者操作持有。

發布經 `KnowledgeStore.publishReview()` 核對人工核准與當前父版，同交易切換發布指標、寫版本及 `notification_intents`。新版 outbox 依提案來源投遞，Telegram BI 回原 bot／conversation，Web／交辦在原回覆入口顯示；從 Telegram Main 交辦時原回覆入口為 Main bot。舊 BI 意圖依原 BI outbox 鍵及目的地重建或查重。交辦本身在提案已存時回「已送審」及擁有者可開的審核連結，人工發布是之後的獨立通知。 [BI 來源](../../apps/adapter/src/telegram/router.ts) · [核對引文與工作台操作](../../apps/adapter/src/http/review.ts) · [發布與通知交易](../../packages/knowledge/src/store.ts)

## 5. 工作佇列與交辦（3B2）

### 5.1 派送與租約

Web 和 Telegram 直接對話、BI 即時收件、補件及 3B 保留的既有 BI 排程入口都寫 `agent_work_items`。`BEGIN IMMEDIATE` 領取已到 `ready_at` 的工作，按同助理 `direct → delegation → schedule`、`enqueued_at`、ID 排序。執行中的工作不被搶占。同助理一筆寫工作持有租約；只有由 OEP 固定已發布查詢或純狀態查詢證明唯讀的路徑可並行，其模型步驟仍受全域模型席位限制。一般對話與交辦先視為可寫。依可用資源選取可派項目，勿讓一個等待中的助理擋住其他助理。每會話一個進行中回合維持既有行為，Telegram 同對話按收件順序等候。

工作狀態為 `queued → running → succeeded/failed/cancelled/indeterminate`，排隊過期用 `timed_out`，執行超時以停止對帳後的 `timed_out` 或 `indeterminate` 呈現。寫入租約以 partial unique index 限制（含 `indeterminate` 保留租約），完成更新必須比對 `lease_id`。程序恢復時對已聲明派送者查 OpenCode inbox、訊息、active 狀態與領域 effect；已驗證從未送出才可回到佇列。未知時保留該助理寫入席位及受影響的 runtime 席位，直到能確認停機／完成／可恢復；租約逾期本身不能授權重跑。等待人工審核屬業務狀態，提案落地後即釋出席位。若 Telegram 台帳與中央工作分庫，預先保存固定 `run_id` 和送件意圖，藉唯一作業鍵重建映射，已接單的訊息與通知不會因回覆遺失而失去關聯。

`BiScheduler.reconcile()`、`runNow()` 保留 `(schedule,wall)`、IANA 時區、同 slot 冪等及 UTC 補跑窗口。3B 改把現有 BI occurrence 和未完成的 `KnowledgeStore.reconcileBi()` 項目交給共用派送器，領取後仍以 `enqueueBi()/runBi()` 業務台帳維持冪等；`startTelegram().action()` 的即時／重跑入口亦經此派送器，避免旁路。3C 增一般助理訊息／定時觸發、每排程互斥、跳過重疊、漏跑一次或略過、每日額度、目的地與獨立排程會話，重用 occurrence key、queue、lease 與 outbox。人工確認改由審核處理，不讓排程等待。 [現有排程](../../packages/knowledge/src/jobs/scheduler.ts) · [BI 工作與領取](../../packages/knowledge/src/store.ts) · [服務派送現況](../../apps/adapter/src/telegram/service.ts) · [觸發衝突分析](../PHASE3_REQUIREMENTS.md#3-觸發衝突分析r7)

### 5.2 工具契約

透過第 3.2 節的 OEP 內建 MCP 登錄 `list_specialists` 與 `delegate_to_specialist`。只讓主助理的使用者發起回合看見兩工具。`list_specialists` 回 `{id,name,introduction,status}`；狀態取自台帳（可用、忙碌、排隊、暫停），不含通道、模型上下文、檔案、個別知識範圍與工作內容。執行端以票券和 DB 角色再驗主助理，目標須為 `active` 專職助理，拒絕主助理為目標，也拒絕交辦／排程／通知回合呼叫。固定 allowlist 同時拒絕 OpenCode 子代理工具。此路徑重用 OpenCode 的工具執行與訊息，不引入第二個 agent loop。

```text
delegate_to_specialist({
  specialistId: AgentId,
  task: string,                  // 1–4,000 字元
  attachmentIds?: AttachmentId[],// 最多 4 筆，必須屬於本回合已選附件
  requestKey: string             // 本則訊息內穩定，1–64 字元
})
  → { delegationId, status: "queued" | "running", noticeCode }
  | { delegationId, status, summary?, files?, reviewRef?, reasonCode? }
  | { errorCode }

DelegationResult {
  delegationId, status: "succeeded" | "needs_input" | "failed" |
                        "timed_out" | "cancelled" | "indeterminate",
  summary?: string,              // 最多 2,000 字元
  files?: { fileId, name, bytes, sha256, mime }[],
  reviewRef?: { reviewId },      // 供已配對擁有者介面開啟
  reasonCode?: string
}
```

所有 object 拒絕額外欄位。工具先驗檔案歸屬、合計至多 40 MiB 且沿用上傳／投影上限；只接受本回合已選的 opaque IDs。父 `agent_id`、session、使用者訊息／run ID、通道目的地由伺服器讀取，不能由工具指定。`requestKey` 重送以 `(parent_store,parent_run_id,request_key)` 回原收據，同鍵不同內容回 `DELEGATION_KEY_CONFLICT`。不同鍵、相同目標／任務／附件雜湊在同一父回合也對帳至同一工作，並存額外鍵，防止模型重複接單。額外鍵亦受父回合的工具呼叫上限，無法藉此大量寫入。

1. 接單前用 `AttachmentService` 核對內容、身分與類別，以新檔名複製到 OEP 私有交接區。複製完成後在單一 `web.sqlite` 交易記錄預算、工作、交辦、inbound 檔案 manifest 與排隊狀態；回覆收據後由 worker 啟動。崩潰時只回收沒有 durable manifest 的 staging。派送再驗壓力預算、權限、分類和檔案雜湊，把有效副本交給專職端新會話。
2. 專職端建立 `origin=delegation` 的獨立 session 與 run，使用自己的預設工作資料夾、有效模型、知識範圍和工具。輸入包含明確任務及所選檔案副本。BI 交辦由 BI service 以專職 run 執行，其領域效果收據作為完整紀錄一部分，毋須讓模型代替既有 proposal 流程做寫入或宣告成功。一般專職則沿用 `ChatService`、`submitOnce()` 及 `waitForOutcome()`。
3. 成功需要已驗證的 run 收據及可交付 manifest；只回摘要、狀態與專職端確認列入 manifest 的輸出，最多 4 份、合計 40 MiB。每個檔案驗 SHA-256、MIME、大小及路徑身分後匯出獨立副本與標記，不提供專職根路徑。BI 的「已送審」須有真實 pending／已接手的 review ID；`needs_input` 可帶受控補件方式，無發布效果。既有 session 資料、工具輸入及完整 child transcript 僅供工作台擁有者開啟。
4. model tool 一律快速回已交辦，若同鍵已有結果則回既有結果。終態及通知 intent 同交易落地。以父 session/run 在主助理對話投影 `delegationId` 結果卡及未讀狀態；Web 以 SSE 提示刷新，重連從 DB 補讀。透過已配對的 `GET /api/delegations/:id` 開右側只讀完整 run，已配對的下載路由檢查匯出 manifest。結果卡可在下一個由使用者發起的主助理回合加入有界摘要與匯出 ID，維持主助理脈絡。主助理通知採 OEP 代其呈現的在地化訊息，完成後不用再啟動模型。
5. 來源為 Telegram 時，原通道以不同穩定鍵排入接單、完成通知；先持久化父回合的回覆，再送該交辦終態，未確定寄送保留人工核對。完成訊息用同一主助理／原 conversation，顯示簡短摘要與工作代號，匯出檔案和審核詳情在已配對工作台開啟。一般 HTTP 中止、視窗關閉與父回合超時不撤回已接單的獨立工作；取消交辦用獨立的擁有者操作。後續通知不啟動其他交辦。

### 5.3 預算、失敗與稽核

- 建議首版每件交辦最多一個專職回合、4 次上游模型請求、12 次模型工具呼叫、90 秒實際執行，並取既有 `turn-limits.ts` 更小的限制。BI 領域提案呼叫計入模型請求；每次重試也計。排隊最多 10 分鐘，時間到而尚未派送則 `timed_out`。同一則使用者訊息的所有交辦最多 3 件、12 次上游請求、36 次工具及 270 秒合計實際執行；父回合保有原回合上限。沿用既有模型輸入／輸出限額與 relay 流量守衛。
- 接單交易先保留整份該件額度，對父 `run_id` 合計「已結束實用量＋執行中／排隊保留」後判斷，件數保留至父訊息結束，重送既有鍵不再計。上游送出前扣請求額度，工具派送前扣工具額度，在 relay 及受控領域模型入口封頂，逾時則中斷並核對。取消或終態結算實用量、釋放未用保留，已實際發生的額度保留。預算滿、目標離線或未授權使用穩定錯誤碼提示，忙碌則排隊。
- 異常用 `submissionCount()`、`waitForOutcome()`、run 收據及 BI effect key 對帳。排隊中取消直接標終態並釋放；執行中停 relay／OpenCode session、撤銷工具票券並核對已接單狀態，確認未發布檔案或提案效果才標取消／逾時。若持久提案或輸出已完成，記錄完成與取消競態，保留已提交結果。若執行中止或效果未能確認，保持 `indeterminate`，恢復後查同一指標再定案，避免自動重跑。無效／缺資料的任務回 `needs_input` 或具體失敗碼，由使用者補件或明確重發。
- `delegation_events` 記接單、去重、排隊原因、領取、工具／模型用量、取消或逆轉原因、收據與通知狀態。結構化診斷僅記 OEP 關聯 ID、目標 ID、時間、用量與原因碼；工作指示、摘要、原始檔與審核收據在受控台帳及交接區保存，日誌禁記私訊、路徑、憑證與票券。 [回合限制](../../apps/adapter/src/opencode/turn-limits.ts) · [送件對帳](../../apps/adapter/src/opencode/reconcile.ts) · [執行紀錄](../../apps/adapter/src/runs/ledger.ts)

## 6. 直接對話、共享資料與「機密」欄位

`origin=web/channel` 的專職會話只供該助理當次會話與擁有者存取。主助理可見的資料為專職目錄、自己交辦的摘要及顯式匯出檔；它的模型沒有列舉專職會話、工具、檔案、收件匣或工作詳情的入口。擁有者的工作台仍可從各助理打開歷史，或從交辦卡在右區看該專職 run。每個 `state`、SSE、附件、下載與註記操作同時比對擁有者身分、來源路徑及 session 歸屬。改派 bot 保留舊會話歸屬，新的助理使用新映射。主助理委派及排程不會載入專職直接對話歷史。

共享資料限擁有者授權的已發布知識，以及 3D 已核准的共享集合。主助理可查自己有讀權的已發布庫，也可交辦擁有該權限的專職助理依共享規則查詢，回傳最小必要結果。3D 的「加入記憶」保留 `owner_agent_id` 與私有來源會話指標；擁有者另外明確共享範圍後才可給其他助理。集合會有 owner/grants、版本化 schema、唯一業務鍵、`review_before_write` 和 `origin_agent_id/run_id`。名片預設需審核，先以 `proposal_only` 存待審，再由 OEP 單一交易寫入核准記錄與稽核。引用用受控資料 ID，跨助理的來源會話仍由擁有者檢視。

3B 為 D2 定義 `classification T CHECK IN ('unclassified','public','confidential')`，預設 `unclassified`。工作資料夾在 `agent_workspaces.classification`；檔案在 `web.sqlite` 的 `file_classifications(file_kind T, file_id T, workspace_id T FK, sha256 T, classification T, updated_at I)`（主鍵為前四欄，`file_kind` 為 `attachment/artifact/handoff/workspace`）；知識庫在 `knowledge.sqlite` 的 `vault_classifications(vault_id T PK FK vaults, classification T, updated_at I)`。舊資料有空附表時視為未分級，極少量的已顯式標記資料隨備份回復。對衍生檔、引用、摘要和交接副本保留所用來源集合與最嚴格標記（`confidential` 優先於 `unclassified`，再到 `public`）。檔案內容變更後按新雜湊重新判定；繼承機密時不得用檔案標記降級。3B／3B2 可做 OEP 內部交接並保留標記。未來外部 coding 代理在送出前逐項檢查工作根、檔案、知識引用及衍生內容，只有來源均確認公開才可送出。這欄位與既有發布版本模型授權各自判斷。 [Phase 3 擁有者決議](../DECISIONS.md#2026-11-22-phase-3-擁有者決議)

憑證值沿用程序環境優先與 Windows User scope 回退。Telegram 讀取參考 `telegram/service.ts` 的 `settings()`，新增參照採受限名稱並重用 `custom-mcp-credentials.ts` 的 stdin、狀態與值分離模式；新通道設定僅提交核准的參照名稱，值由 OEP 服務於執行時取得。憑證只存在使用者憑證來源與需要它的程序記憶體；對外請求由通道 adapter 送，模型／OpenCode 不取得 bot 憑證。工作台顯示設定及驗證狀態，備份僅列重新綁定所需名稱。日誌、錯誤、資料庫、repo、UI 回應、子程序參數與模型回傳均遮蔽實際值；通道 API 的錯誤使用類別碼。BI 發布路由只接受擁有者配對與有效的 CSRF，MCP listener 無法路由到工作台 API。信任邊界是 OEP 所控制的流程；同一 Windows 使用者在 OEP 之外啟動的程式由 OS 控制。 [現有憑證機制](../../apps/adapter/src/runs/custom-mcp-credentials.ts) · [ADR-006、ADR-013](../ARCHITECTURE_DECISIONS.md)

## 7. 工作台與雙語

| 區域 | 互動 |
| --- | --- |
| 左側「助理」 | 列主助理、BI 與其他專職助理。列上顯示頭像、名稱、可用／忙碌／排隊／停用狀態與可識別的 bot 名稱。點助理開中央詳情，列上的「開始對話」直接建立該助理的會話。區塊「＋」開中央精靈，更多選單有複製／封存；內建主助理無封存或刪除入口。頂端顯示目前會話所屬助理。 |
| 左側「會話」 | 以助理分組，主助理組的舊會話再以兩個工作資料夾區分。搜尋、會話數、改名、刪除與收合沿用原行為，最後選擇保存在本機。屬於專職的 Web 對話與已授權可閱的通道對話按來源標示；交辦和定時紀錄從結果卡或工作列表開啟。 |
| 中央「助理詳情」 | 「基本」含頭像、名稱、簡介與指示，顯示受管資料夾及可匯入的唯讀資料夾。「模型」列 3A 已選清單、全域預設選項及待套用狀態。「知識庫」多選已發布可用來源，另列只能送審的寫入目標。「通道」列帳號與回覆語言。「觸發」「能力」先顯示適用的現有行為與後續項目，可跳至已有的外部工具設定。 |
| 中央「設定」 | 「助理與通道」表顯示通道、bot、助理、回覆語言、驗證／poll／事件狀態與操作。衝突在表列與精靈步驟即時定位，儲存仍由 DB 檢查。外觀保留全域主題、密度與介面語言。原助理與頭像設定導向主助理詳情，原專案與資料夾及整合設定保留操作入口。 |
| 右側「附加資料」 | 主助理訊息下的交辦結果卡顯示專職名稱、工作狀態、摘要、檔案和「查看執行紀錄」；開按需分頁保留中央原對話。列執行與效果時間線、適用的模型／工具活動、收件或審核連結及檔案。沿用現有預覽、下載、窄版全幅覆蓋、鍵盤分頁、Esc 關閉及焦點還原。 |

精靈依序為「基本資料 → 模型 → 知識庫 → 能力 → 通道 → 觸發 → 確認」。基本同詳情欄位；模型選擇全域預設或已選 ID；知識庫勾讀取庫；能力提示既有外部工具與後續功能；通道允許先略過並設定回覆語言，或選已驗證待指派的連線（既有已綁帳號從全域設定明確改派）；觸發說明已綁通道可收訊息、定時設定後續開放；確認顯示名稱、工作資料夾、模型、授權及 bot。待指派連線在精靈中只是草稿，可先驗證，直到成功建立助理與帳號綁定的同一交易才成為帳號列。精靈完成前僅保存瀏覽器草稿；確認用設定 revision 與交易重驗，建立資料夾失敗則移除無引用暫存或由重啟清理。從現有專職助理複製可預填基本、模型及讀取庫待確認；新助理有新資料夾，既有通道、寫入權、工作檔及憑證須各自指派。3B 遷移可分段沿用既有頁面，在 3B 完成時全部操作可由三區版型到達。

3B 新端點採 `startAdapter()` 同源 API。預定以 `GET/POST /api/agents`、`GET/POST /api/agents/:id` 與 `/api/agents/:id/workspaces/:workspaceId/sessions` 管理助理及會話；既有 `/api/projects/:id/sessions` 相容主助理兩個工作區。`GET/POST /api/settings/channels` 驗證／更新帳號綁定。3B2 加 `GET /api/delegations/:id`、`POST /api/delegations/:id/cancel` 和按 manifest ID 下載，將父 session/run 與 child run 的關聯在伺服器查清才送出。右欄用 OEP 專用狀態與 `WebEvents` 發失效提示，既有 OpenCode SSE 經 `sessionEvents()` 白名單映射後才給 UI。 [工作台版面](../GUI_LAYOUT.md) · [GUI 藍圖](../GUI_REDESIGN_BLUEPRINT.md) · [前端外殼](../../apps/web/src/app.js) · [路由](../../apps/adapter/src/main.ts) · [事件投影](../../apps/adapter/src/http/events.ts)

雙語沿用 `apps/web/src/i18n.js` 和 `i18n/{zh-TW,en}.js`，兩份同時新增 `agents.*`（角色、狀態、頁籤、空狀態、aria、精靈）、`channels.*`（映射、語言、衝突）、`delegations.*`（狀態、通知、取消、錯誤、紀錄）、`reviews.agentSource`。後端回傳穩定 `code`／安全參數，由工作台依介面語言及通道依助理語言取值。內建名稱有雙語初值，使用者自訂文字、對話、檔名、知識內容原樣顯示。保留本機語言記憶及即時切換，驗英文長字串、鍵盤、對話內容原文。 [前端語言程式](../../apps/web/src/i18n.js) · [雙語驗收契約](../../tests/contract/web-i18n.test.ts)

## 8. 驗收計畫

以下為實作切片的驗收，使用固定版 OpenCode 及合成資料。各端對端命令使用獨立暫存 `OEP_DATA_DIR`、隔離的 Windows Job 與 Chromium profile，通道與模型打入合成服務。

| 類型 | 主要驗證與判定 |
| --- | --- |
| 合約與 Runtime | 驗 `STRICT`、主助理唯一且不可刪除、revision 寫入衝突、workspace 歸屬與模型切換回退。用 `test:contract`、`test:contract:native` 加案例，擷取合成 Gateway 的兩助理工具清單、已套用模型、截斷與回合歸屬。驗票券 forge／replay、遲到與切換、移除／撤銷授權、工作簿仍可用、設定失敗不放寬。嘗試跨助理、跨 session ID／路徑、reparse／hard link、工作區互換及 UI/SSE 越界，預期無資料與副作用。驗發布範圍、未授權庫、待審候選及機密繼承。 |
| 資料遷移 | 舊 DDL fixture 直接遷移，核對兩 workspace、Web 及 Telegram 原 ID、附件／產物 hash、已隱藏會話、模型、語言初值、憑證參照與自訂授權。比對 BI 狀態、來源、草稿版本、發布指標、blob 與 outbox；連續遷移兩次、DB 交易中途失敗、單庫完成後中斷都驗資料無重複。未知、越界及工作關聯遺失的資料阻擋啟用。 |
| 瀏覽器 | 增補 `test:e2e:browser`／`test:e2e:web`。用精靈建立、取消、複製、封存，從主助理與專職助理建立及開回舊會話，核對通道衝突、設定回退、專職直接對話與交辦詳情分離。寬／窄、淺／深、繁中／英文與即時切換，Tab、方向鍵、Esc、focus restore、右欄空置不佔空間。模型狀態、主要操作和通知持久可見；對話及檔名來源不翻譯。 |
| 合成 Telegram | 擴充 `tests/integration/telegram.test.ts`。兩個舊 bot 與第三個專職 bot、同一 bot 的兩種 token 驗證衝突、執行中改派等待、同 topic 不同 bot 的會話與去重分離。驗許可使用者、cursor commit 後才前移、重送／限流／不確定寄送、工作長排隊後仍回原目的地、兩種助理語言、重啟後一次領取與已送通知不重複。 |
| 交辦端到端 | 固定 OpenCode 加合成 Gateway 生工具呼叫及拒絕案例。Main 回已交辦後可繼續對話，兩個專職均有獨立 session／run 與實際各自模型，右欄可開，成功檔案 hash 相同且沒有跨根讀取。對同一助理預置 schedule、delegation、direct，斷言依優先序；仍在執行的工作不被搶占。驗重送同鍵相同／不同內容、預算第四件被拒、工具與時限封頂、專職或偽造父回合無法交辦、取消排隊／執行中／已落地、重啟對帳與 Web / Telegram 完成通知。 |
| BI 端到端 | 依需求第 8 節送合成 HTTPS 連結或檔案至 BI bot，先保留收件，測一次 UTF-8 補件與偽造引文拒絕；正例產生候選及「BI 資料處理」來源，發布前 Ask／搜尋無該候選。擁有者先核准再發布，Telegram 收一次原 bot 通知，發布後有讀權的助理能查且可核對證據；BI 呼叫發布被拒。用 Web Main 上傳另一份同格式來源交辦，得不同 review 與專職 run、已送審及可開連結；擁有者同樣核准／發布，Web 收發布事件。直接向 BI 查狀態／補件後確認 Main 看不到那段對話。 |
| 跨版本升級／回復 | 擴充 `tests/contract/upgrade-allowlist.test.ts` 與 `tests/e2e/upgrade-rollback.test.ts`，從舊模型選擇 fixture 及 `db4ff99` 多 DB fixture 升級。既有列摘要、發布 hash、受管資料與 OpenCode profile 維持；驗少一列、錯歸屬、未知非空表、改一個檔案位元組均被拒。模擬快照後與切換前崩潰及回退，舊程式和舊 DB 成套恢復，差異報告有新待處理工作雜湊且無憑證。 |

## 9. 實作切片

依表列順序提交。相容層維持每次合併的 Web、Telegram、BI 與工作簿入口，未完成的功能保持關閉。切片自帶離線合成驗收，升級允許清單與 fixture 隨使用該 schema 的切片一起提交。

| 切片 | 範圍與首要檔案 | 可獨立驗收 | 主要風險 |
| --- | --- | --- | --- |
| 1 · 助理台帳與跨版遷移（3B） | `runs/web-store.ts`、`runs/ledger.ts`、`scripts/windows/{migrate-data.ts,data-snapshot.mjs}`、`tests/fixtures/upgrade/`。加入助理、資料夾、會話 owner、設定與分類表；種內建助理並保留舊讀法。 | 舊 DDL 及空目錄連續遷移，舊會話、檔案、模型資格及版本對帳一致；DB 拒絕刪主助理。 | 遺漏隱藏會話或第二個 DB；用舊表全列做完整性比對。 |
| 2 · 隔離執行與內建工具（3B） | `http/chat.ts`、`opencode/{sessions.ts,gateway.ts,reconcile.ts,knowledge-mcp.ts}`、`runs/{workspace.ts,project-folders.ts,custom-mcp.ts}`、`apps/launcher/src/{runtime.ts,supervisor.ts,knowledge.ts}`。加入 scope、受控檔案能力與派送 core；Web 及舊 Telegram 一起使用鎖。 | 固定版合成測試斷言不同助理模型清單與工具權限、舊會話及 Excel 正例、跨根讀寫與票券重播被拒。 | 固定版權限覆蓋與文件寫入競態；通不過 gate 時保持助理新工具路徑關閉。 |
| 3 · 通用通道及 BI 領域歸屬（3B） | `telegram/{service.ts,router.ts,inbox.ts,poller.ts}`、`http/review.ts`、`packages/knowledge/src/{store.ts,ingest-migrations.ts,jobs/scheduler.ts}`、升級與 Telegram 測試。引入帳號、spool、BI service、綁定 API 與 provenance。 | 合成多 bot 增刪綁定、舊 pending／outbox 未重送、BI 直接查詢補件與送審／發布回原 bot。 | 不同 DB 之間重送、路由及語言走錯；以固定鍵、快照 revision 和故障注入驗證。 |
| 4 · 建立精靈、助理與通道畫面（3B） | `apps/adapter/src/main.ts`、`apps/web/src/{app.js,style.css,i18n/zh-TW.js,i18n/en.js}` 及工作台設定、審核視圖。完成 API 與三區整合、設定映射及空狀態。 | 用瀏覽器建立專職、對話、調整模型與綁定；舊工作區及 BI 審核在雙語、窄版與鍵盤正常。 | 側欄會話或既有入口遺失；依功能對照逐項驗證。 |
| 5 · 交辦工具、台帳與預算（3B2） | `opencode/knowledge-mcp.ts` 的 transport 接點、`opencode/gateway.ts`、`http/chat.ts`、`runs/ledger.ts` 與新的 delegation service／派送、BI 領域入口。先由合成用戶端驗可授權接單、排隊與取消，完整功能旗標待切片 6。 | 一層交辦、跨助理接單、同助理優先序、來源隔離、預算／去重與重啟對帳；BI 交辦有 pending review 收據。 | 晚到的工具呼叫、父額度競爭、取消已完成效果；以授權票券、單交易保留及對帳處理。 |
| 6 · 結果、通知與完整驗收（3B2） | `main.ts`、`http/events.ts`、`telegram/service.ts`、Web 訊息與右欄、測試。投影結果卡、附加資料、取消、檔案下載、已送審和後續發布通知，開啟完整功能。 | 瀏覽器與合成 Gateway／Telegram 交辦 E2E，兩條 BI 驗收路徑、SSE 重連、同目的地通知無重複與整包升級回退。 | 父回覆與終態通知逆序或重複；對照持久 intent、outbox 及原綁定。 |

## 10. 擁有者待決

1. **既有外部工具的升級取捨。** 建議保留任意本機程式與本機／私人網路 MCP 的設定和憑證參照，在助理端暫停，待隔離驗證完成再啟用。若舊工具必須在升級當天可用，隔離工作需要提前到 3B，影響切片 2 的範圍與時程。
2. **交辦的預設用量。** 建議每則使用者訊息最多交辦 3 件，每件 90 秒實際執行、4 次模型請求、12 次工具呼叫與 10 分鐘排隊期限。請確認是否符合日常工作與費用預期。
3. **D7 的預設排程目的地（3C）。** 建議專職排程結果預設回報主助理，由它通知擁有者；每筆排程可改指定專職通道或只存檔。3B／3B2 繼續使用原 BI 排程及本案的原會話通知規則。

## 11. 擁有者決議（2026-11-22）

1. 既有外部工具：採建議。擁有者目前沒有自訂 MCP 設定，暫停對助理開放不影響現有使用；隔離驗證完成後再開放。
2. 交辦額度：每則使用者訊息最多交辦 3 件，**每件最多 5 分鐘實際執行**（取代 90 秒）。模型請求與工具呼叫上限按比例調整（建議每件 10 次模型請求、30 次工具呼叫，每則訊息合計 30／90），排隊最多 10 分鐘。所有預設值須可在「設定」調整，並受既有回合限制約束。
3. D7：專職助理排程結果預設回報主助理，每筆排程可另行指定。

## 12. 切片 2 契約關卡結論（2026-11-22，技術負責人）

切片 2 的固定版 OpenCode v2.3.2 契約測試結果：SSE 路徑的傳輸欄位注入、nonce 與欄位遮蔽、工具允許清單、權限整份覆蓋全部通過；JSON completion 案例失敗，原因是 OpenCode 的 OpenAI 相容 provider 固定以 `stream: true` 發出請求，只解析 SSE。

查核 `apps/adapter/src/opencode/gateway.ts`：relay 依請求的 `stream` 旗標選解析器，OpenCode 的請求一律是串流，relay 以 `bufferedCompletion()` 完整緩衝上游 SSE 後再以 SSE 回給 OpenCode。JSON 解析器只服務伺服器端直接呼叫者（知識問答、BI 提案，皆 `stream: false`），這些呼叫不經 OpenCode 工具執行，屬第 3.2 節的「受控入口由伺服器 dispatcher 直接建立 scope」。因此第 3.2 節要求「兩種 completion 皆注入傳輸欄位」對 OpenCode 工具路徑而言只需 SSE。

修訂：
1. OpenCode 工具呼叫的授權只走 SSE 路徑，第 3.2 節的注入、剝除與允許清單檢查在 SSE 完整緩衝後執行。
2. relay 對來自 OpenCode 受管 session 的請求，若 `stream` 不是 `true` 且帶有工具定義，一律拒絕（fail closed），並有測試。
3. 上游對串流請求回傳非 SSE 時維持現行錯誤處理（拒絕），不轉換。
4. 契約測試的 JSON 正例改為上述 fail-closed 斷言；SSE 正例保留。
