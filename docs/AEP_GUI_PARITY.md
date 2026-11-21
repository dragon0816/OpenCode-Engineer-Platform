# AEP Web GUI 唯讀盤點

2026-11-21（Asia/Taipei）。在 OS 暫存目錄淺層 clone 後唯讀比對，HEAD 為 `c9961b2d0d66eef3892375213ce305883ebde960`，工作樹乾淨、根目錄無 LICENSE。下列項目描述可見行為與條件顯示的控制項。相同功能的表單欄位與提交動作列在同一列。AEP 程式、畫面與資料均不構成 OEP 交付物。 [固定版來源](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960)

| 代號 | 固定版來源路徑 |
|---|---|
| W | `src/host_runtime/web_page.py` |
| M | `src/host_runtime/memory_page.py` |
| A | `src/host_runtime/agent_mode_settings.py` |
| T | `src/host_runtime/telegram_settings.py` |
| F | `src/host_runtime/workflow_settings.py` |
| S | `src/host_runtime/schedule_web.py` |
| R | `src/host_runtime/review_routes.py` |
| B | `feature_plugins/bi_knowledge/python/aep_bi/host/bi_page.py` |
| I | `feature_plugins/bi_knowledge/python/aep_bi/inbox/page.py` |
| K | `feature_plugins/llm_wiki/python/aep_wiki/host/wiki_page.py` |
| G | `docs/guides/BI_BUILD.zh-TW.md`、`docs/guides/BI_SOP.zh-TW.md`、`docs/guides/BI_SKILL_EXAMPLES.zh-TW.md` |
| C | `docs/guides/CODING_LARGE_REPO.zh-TW.md` |
| V | `docs/guides/VOICE_INPUT.zh-TW.md` |

## Settings

階段 2b 表示搭配其他階段逐步交付，最晚於 Phase 5 打包前驗收。省略項目的理由及負向驗收保留在矩陣。

| 來源與設定 | OEP 決策 | 位置 | 階段 | 驗收 |
|---|---|---|---|---|
| W Agent 名稱、自介、soul.md | Adapt to OpenCode | 設定／助理 | 2b | 保存三值並重開，僅後續回合用更新後指令。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W Avatar 上傳、挑選、重設 | Keep | 設定／外觀 | 2b | 以合成 PNG 更換、重開、還原預設，拒絕無效圖片。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W Gateway Start／Restart／Refresh token／開機自啟 | Omit-with-reason（Gateway 為外部服務，無管理權） | 設定／整合說明 | 2b | 不顯示管理動作，測試只命中允許的推論路徑。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W Gateway Test、provider、alias、URL、模型清單／手填、context capacity | Adapt to OpenCode | 設定／模型、對話頁首 | 2b | 切換核准模型並成功送合成 turn。拒絕未知 alias，錯誤僅報狀態。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W SecretRef／環境變數選擇 | Replace（使用 OEP 憑證繫結） | 設定／模型 | 2b | 顯示已設定狀態，HTML、API、log 都沒有值。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W 最近訊息、歷史 byte budget、工具次數、回合時限 | Adapt to OpenCode | 設定／回合限制 | 2b | 驗上下界，下一回合達界時呈現對應狀態。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W 已存會話選擇與刪除 | Keep | 左欄／會話管理 | 2b | 取消保留原會話，確認僅清除目標會話。已驗證 Web 清單與存取範圍，保留稽核資料。 [Chromium 驗收](../tests/e2e/web-browser.test.ts) |
| W 多 Agent 委派開關 | Adapt to OpenCode | 設定／助理 | 2b | 固定版 OEP 只設定主要助理及既有許可工具，委派開關停用並顯示原因。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W、T Telegram 開關、token、sender／actor、查詢聯絡 bot 的人 | Adapt to OpenCode | 設定／兩個 bot | 4 | 開關、換值、發送者核對與拒收各測一次，憑證不回傳。 |
| W Shared Platform portal／bridge URL、Personal Agent code、帳密登入、enroll、teams | Omit-with-reason（AEP 公司 Bridge 與組織帳號） | 設定／整合說明 | 2b | 頁面沒有公司登入、授權或登錄請求。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W Shared Platform 憑證 fingerprint／信任／下載／忘記 | Omit-with-reason（AEP 自訂 Bridge 信任） | 設定／整合說明 | 2b | OEP 連線無此信任寫入，無效 HTTPS 憑證拒連。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W Laya SSH host／ports／account／mode／threshold／timeout／approval／auto／check | Omit-with-reason（AEP 專用 SSH 決策服務） | 設定／整合說明 | 2b | OEP 不啟動 Laya 或 SSH tunnel。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W MCP 名稱、stdio command／args／cwd／env／secret env、remote URL／headers／token、timeout、啟停、重連、移除與狀態 | Adapt to OpenCode | 設定／MCP | 2b | 兩種合成 transport 各驗連線、啟停、逾時及憑證遮罩。3a 先提供內建唯讀知識工具。 |
| W、C Coding agents 安裝、移除、狀態；A 的 Claude Code／Codex／Copilot 開關與登入 | Replace（OpenCode 固定版本與 OEP agents） | 設定／Runtime | 2b | 顯示 pin、相容性與健康，切換 OEP agent 後識別新 session。安裝與升級由 5 交付。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W、A Agent mode 預設根目錄、會話工作與唯讀資料夾 | Adapt to OpenCode | 設定／專案與會話面板 | 2b | 兩專案分別開新會話，驗唯讀目錄、跨會話拒絕及有效工作根。 |
| W、A Email folders、days、舊 exclusions、會話 mail grant | Replace（核准的郵件 MCP 與專案設定，舊欄位已停用） | 設定／MCP | 2b | 合成 connector 限定資料夾和天數，未允許時查詢拒絕。 |
| W Agent profile／Capability management | Adapt to OpenCode | 設定／助理與能力 | 2b | 顯示有效 agent、工具與 skill 狀態，停用後新回合不列該能力。 |
| W、F Workflow 本機設定與動態參數 | Replace（OEP 工作參數與 OpenCode 指令） | 設定／工作，工作面板 | 4 | 同工作兩組本機設定各執行一次，參數與憑證參照各自生效。 |
| W、V Web 麥克風及 Telegram 語音啟用／轉錄設定 | Adapt to OpenCode | 設定／輸入、Telegram | 2b／4 | 模擬有無授權與轉錄失敗，成功只填入輸入框或送至對應 bot。 |
| W、B BI query toolbox 開關、Atlas URL | Adapt to OpenCode（使用範圍受限的查詢工具與外部連結） | 設定／知識 | 2b | 開關後新會話工具清單隨之更新。外部連結須明確點擊才開啟。 |

## Operations

| 來源與操作 | OEP 決策 | 位置 | 階段 | 驗收 |
|---|---|---|---|---|
| W 新會話、搜尋、切換、會話模型選擇 | Adapt to OpenCode | 左欄與對話頁首 | 2／2b | 專案清單、新增、搜尋、切換、改名、刪除及跨專案路由隔離已驗收。緊湊會話列、鍵盤選單、搜尋與清除已驗收。會話模型切換已驗收。 [Slice 2A](reviews/PHASE2B_SLICE2A_REPORT.md) · [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md) |
| W 私有、public 會話及 backend 驗證 | Replace（本機 OpenCode；D04 單使用者） | 左欄、設定／Runtime | 2b | 新會話走本機授權，拒絕未認證及非 loopback 請求。 |
| W 送訊息、排隊、進度、delegation、資料夾操作 | Adapt to OpenCode | 中央、輸入框、工作面板 | 2／2b | 安全 Markdown、活動摘要與工具卡展收已驗。生成時顯示等候秒數。逐 token 顯示與 SSE 遺漏事件補齊仍開放。 [Slice 2B](reviews/PHASE2B_SLICE2B_REPORT.md) |
| 停止對話回合 | Adapt to OpenCode | 輸入框 | 2b | 合成慢速 Excel 回合已驗停止、帳本、重複停止及產物拒絕。 [Slice 2A](reviews/PHASE2B_SLICE2A_REPORT.md) |
| W 回覆指定輪次、複製、原因、評分、區段／摘要筆記 | Adapt to OpenCode | 訊息操作、筆記面板 | 2b | 在第二輪引用第一輪，保存評分與筆記並核對原輪定位。 |
| W 附件、移除、下載、原文／表格／影像／HTML 預覽、Atlas embed | Adapt to OpenCode | 輸入框、檔案／產物面板 | 2／2b | 附件上傳、移除、下載雜湊、文字、表格、影像及隔離 HTML 預覽已驗收。PDF 顯示檔案資料及下載提示。Atlas embed 待驗收。 [Slice 2B](reviews/PHASE2B_SLICE2B_REPORT.md) |
| 產物版本差異 | Adapt to OpenCode | 產物面板／差異 | 2b | 同會話兩版 XLSX 驗證變更儲存格數量及前後值。 [Slice 2B](reviews/PHASE2B_SLICE2B_REPORT.md) |
| W Slash palette、直接指令及 action card 決定 | Adapt to OpenCode | 輸入框、對話卡 | 2b | 用鍵盤搜尋並執行允許指令，接受／拒絕卡片各一條。 |
| W 能力清單技能／工作流程／知識／擴充／應用，更新、查找、狀態篩選、詳情、安裝草稿、啟停移除 | Adapt to OpenCode | 設定／能力 | 2b | 合成項目從待啟用到停用、移除，清單與工具狀態一致。 |
| W Installed Workflow 執行表單、上傳、動態選項、JSON 參數及 Recent runs | Replace（OpenCode 指令及 OEP 工作帳本） | 工作面板 | 4 | 同設定手動執行後，查得輸入及結果的對帳紀錄。 |
| W Share Platform Library 分類／查找／狀態／同步、安裝、Portal 授權與提交審核 | Omit-with-reason（需 AEP 公司服務與資產權限，OEP 使用本機能力管理） | 設定／整合說明 | 2b | 整合說明交代服務與組織依賴。未發 Bridge／Portal 請求。 [Slice 2C](reviews/PHASE2B_SLICE2C_REPORT.md#已驗收) |
| W、R Reviews 清單、刷新、接受／延後／拒絕／完成、原會話與知識缺口 | Adapt to OpenCode | 左欄／審核 | 3b | 兩筆候選分別接受與拒絕。接受前與拒絕後均無法由 Ask 取回。 |
| W、R 案例回顧 Review now、保留天數、夜間、建議 skills、比較上限 | Adapt to OpenCode | 審核設定、工作 | 4 | 合成重複案例依設定進入手動或定時回顧，建議須經核准。 |
| W、M 記憶待確認／偏好／筆記／資料／同步進度／紀錄、立即檢查 | Adapt to OpenCode | 面板／記憶 | 2b | 新建與撤銷一筆偏好，確認適用範圍、健康狀態及紀錄。組織同步依 D04/D05 延後。 |
| W、M 搜尋／標籤／關聯、勾選匯出 Markdown、聯絡人狀態與編輯 | Adapt to OpenCode | 面板／筆記及聯絡人 | 2b | 用兩筆合成聯絡人篩選，只匯出選定筆記。 |
| W、M、G 名片辨識、更新去重、組織圖檢視及調整 | Adapt to OpenCode | 檔案、資料面板 | 3b | 合成名片更新同一 ID，組織圖重開反映核准關係。 |
| W Tasks 更新、狀態、待確認變更 | Adapt to OpenCode | 左欄／工作與面板 | 3b／4 | 會話執行台帳與 BI 工作、排程摘要可從同一面板查閱。完整待審流程另行驗收。 [Slice 2B](reviews/PHASE2B_SLICE2B_REPORT.md) |
| W、S 新增或編輯排程、批准／拒絕、時間／週期／IANA zone／參數、暫停／恢復／移除／Run Now／歷史 | Adapt to OpenCode | 左欄／排程 | 4 | 模擬漏跑、重啟、暫停與即時觸發競態，單 occurrence 最多一筆執行。 |
| W、B、K 知識刷新、BI／Wiki 切換、庫／domain 選擇、Ask 與引用 | Adapt to OpenCode | 左欄／知識，Ask API／MCP | 3a | 選單限一庫，顯示版本、來源、evidence，偽造引文與跨庫版本須拒絕。 |
| B、G 已發卡片概覽、類別／domain／sample 篩選、詳細資料及關係、全文查詢、重建索引 | Adapt to OpenCode | 知識／卡片、維護 CLI | 3a／2b | 3a 匯入後對帳 IDs、關係、版本、FTS 與恢復，2b 由頁面依條件瀏覽詳細卡片。 |
| B、G 新增 BI 庫／領域、機密分類、來源選檔／轉檔／預覽／移除、Markdown 草稿修訂 | Keep | 知識／BI 建置 | 3b | 合成檔進 staging，版本保留且未核准前查無資料。 |
| B、G schema 建議／助理／草稿／差異／升級、skill 新增／編輯／匯入／匯出，Profile 與資料處理程式 | Adapt to OpenCode | 知識／建置設定 | 3b | 更新合成 schema、規則與 profile，驗不符版本及未授權執行均拒。 |
| B 資料集新增、從 JSON 安裝 schema、安裝範例 schema | Adapt to OpenCode | 知識／建置設定 | 3b | 載入合成 schema 後只能對應其版本開啟資料集，畸形 JSON 無法安裝。 |
| B、G Ingest 批次／停止、欄位／關係預覽、逐一／批次定案及修正 | Adapt to OpenCode | 知識／審核 | 3b | 中斷批次後重啟，核准範圍及來源定位可對帳。 |
| B、K、G Benchmark 題目增改、AI 草擬、執行、逐題結果 | Adapt to OpenCode | 知識／品質 | 3a／3b | 3a 固定 gold set 可重跑。3b 保存合成題目後測試，錯題可展開原引文。 |
| B、G Dashboard 查閱與篩選、AI 編寫 SQL、預覽、增改排序／套用 | Replace（D05 先做概覽，2b 提供已發布資料的固定唯讀查詢與排序；進階 SQL 作者功能依 D05 延後） | 知識／概覽 | 3a／2b | 3a 顯示正確版本、計數與狀態。2b 用固定查詢預覽合成資料、保存篩選與排序。 |
| B、G 版本／分享 commit、push、tag、發布、加入／連線與衝突處理 | Replace（本機不可變快照匯入與 OEP 發布／回退；多人同步依 D05 延後） | 知識、維護 CLI | 3a／3b | 匯入兩版、回看各版證據。3b 必須經審核才能發佈，衝突保持原指標。 |
| B Shared Platform 瀏覽／訂閱／同步資料集與組織可見性 | Omit-with-reason（依賴公司 Bridge 和組織權限，D04／D05） | 知識／整合說明 | 2b | 選擇本機已發布資料集時可讀同等摘要，過程沒有公司服務請求。 |
| B、G 載入示範、Atlas 連結 | Adapt to OpenCode | 知識／概覽 | 2b | 可載入合成示範；Atlas 明確開啟後才離開本機頁。 |
| I、B、G BI Telegram inbox　領域綁定、收件、筆數、篩選、挑選來源、錯誤與補件 | Adapt to OpenCode（D07 單 BI bot 分流） | 知識／收件、設定 | 4 | 訊息重投仍只見一次，受阻連結保留原因和人工補件入口。 |
| K Wiki 新建／加入與切換／捨棄 sandbox、擁有範圍、來源及題目資料夾 | Adapt to OpenCode | 知識／Wiki 建置 | 3b | 切換兩個 sandbox，捨棄其中一個後已發布版本與另一組草稿可讀。 |
| K Wiki Pull、分類上傳、轉檔預覽／執行／停止 | Adapt to OpenCode | 知識／Wiki 建置 | 3b | 預覽和停止只影響 sandbox，完成時來源 hash 相符。 |
| K Wiki skills 規則編修、比較、助理、儲存／復原；選擇轉檔文件與 Ingest／停止 | Adapt to OpenCode | 知識／Wiki 建置 | 3b | 編輯復原並重跑，人工選取與轉檔 evidence 可追溯。 |
| K Wiki 差異、試答、發布候選、更新來源 | Adapt to OpenCode | 知識／審核 | 3b | 草稿試答與發布 Ask 隔離。審核後切換版本，回退仍可核對舊引用。 |

盤點以固定版文檔及程式中可達的表單、頁籤、會話動作和條件分支為來源。執行期載入的 provider、工作流程與外部服務欄位依實際設定變化，驗收以合成實例覆蓋。2b 收尾逐列記錄實作、替代或省略驗收證據。
