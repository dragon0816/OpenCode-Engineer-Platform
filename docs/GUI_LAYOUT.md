# OEP 工作台版面規格

2026-11-22（Asia/Taipei）。Phase 2b 外殼沿用 OEP 的色票、字型、顯示密度與系統、淺色、深色主題。 [重做藍圖](GUI_REDESIGN_BLUEPRINT.md) · [外殼驗收](reviews/PHASE2B_SHELL_V2_REPORT.md)

## 用語

| 概念 | 畫面用語 | English |
|---|---| --- |
| 一組可儲存、搜尋、重新命名的訊息 | 會話 | Session |
| 用來閱讀和傳送訊息的頁面 | 對話 | Chat |
| 處理訊息及工作的幫手 | 助理 | Assistant |
| 發布後可搜尋和詢問的資料 | 知識庫 | Knowledge Base |
| 檢查草稿與決定是否核准的頁面 | 審核 | Review |
| 定時執行、已送出的工作及通知頁面 | 排程與工作 | Schedules & Jobs |
| 附件或助理建立的文件 | 檔案 | Files |
| 開啟檔案內容的操作 | 預覽 | Preview |
| 集中管理可安裝的功能 | 能力 | Capabilities |
| 在能力登錄的自訂連線與工具 | 外部工具 | External Tools |
| 顯示預覽或工作詳情的右側區域 | 附加資料 | Details |
| 檢查兩版檔案的畫面 | 變更對照 | Change Comparison |

新增或修改工作台介面文字時，請在同一項變更新增或更新兩份語言檔的對應字串。

## 功能欄

- 頂端顯示主助理的頭像、名稱及一行自我介紹，取自主助理詳情。
- **主功能**包含對話、能力、知識庫、排程與工作、審核、設定。能力入口在主功能收合時保持可見。審核列出各知識庫的卡片與文章草稿。
- **會話**顯示使用中的助理會話數，依助理分組。主助理底下的「日常資料夾」與「獨立資料夾」對應原有的兩個工作區。可搜尋這些會話、用「＋」新增，以及從「⋯」重新命名或刪除。重新載入會回到上次選取的會話。
- **助理**顯示頭像、名稱、狀態與綁定的機器人。點選助理會開啟中央詳情，「開始對話」會建立該助理的會話。「＋」開啟建立精靈。「更多」可複製助理，或刪除自行建立的助理。底部的「已刪除的助理」預設收合，展開後可閱讀過去的會話和還原助理。主助理的對話用途選單保留資料分析與 Excel 工作表。
- 三個區塊各自收合。瀏覽器在重新載入後保留各區塊的狀態。800 px 以下以「功能導覽」按鈕開啟整欄。

## 中央內容

- 頂列左側顯示目前模型、模型來源與對話的處理狀態。右側顯示目前會話的助理、本機身分及連線狀態。「⋯」包含語言選單、「停止服務」及對話的附加資料入口。
- 訊息區可捲動。助理回覆中的清單與巢狀清單可顯示粗體、斜體、行內程式碼與連結。離開最新訊息時，可用「跳到最新訊息」返回。對話下方的會話檔案按鈕可直接預覽附件和助理建立的檔案。
- 整個輸入區與對話區都可拖放檔案，拖曳時顯示「放開以附加檔案」。可用「附加檔案」選取，也可在輸入框按 Ctrl + V 貼上複製的檔案或截圖。文字會貼入目前的游標位置或取代選取的文字。上傳成功與失敗會顯示在輸入區狀態列，圖片可在「附加資料」預覽。可從「已選附件」勾選下一則要傳送的檔案，或選用既有的唯讀資料夾與語音輸入。
- 「附加本機檔案／資料夾」開啟 Windows 選擇視窗。貼上「複製為路徑」後可選「附加為檔案參照」。以拖放或貼上加入超過 20 MiB 的檔案時，狀態列會指引使用本機選擇視窗。
- 模型選單標示設定預設值，切換從下一則訊息生效。若目前只有預設模型，可從「到設定選擇更多模型」直接開啟設定。「停止處理」結束當前回合。下方固定顯示 Enter 送出與 Shift + Enter 換行的提示，中文輸入法組字時可用 Enter 確認選字。
- 助理、設定、能力、知識庫、排程與工作、審核各自使用中央區域。知識庫頁首保留已發布知識庫選單和搜尋狀態。概覽、問答、品質與建置每次顯示一頁，方向鍵可切換。重新載入後再次開啟知識庫，會恢復上一次使用的頁籤與仍可用的知識庫。

## 助理詳情與建立精靈

詳情使用「基本、模型、知識庫、通道、觸發、能力」六個頁籤。方向鍵切換頁籤，Home 和 End 跳到首尾。基本頁顯示工作資料夾與已匯入的唯讀資料夾。模型可跟隨全域預設，也可從已選清單指定。知識庫可勾選已發布的讀取來源，並列出只能用提案送審的目標。通道頁可修改回覆語言，能力頁顯示外部工具授權與暫停狀態，並連到 Skill 及 MCP 管理。

精靈依序顯示「基本資料 → 模型 → 知識庫 → 能力 → 通道 → 觸發 → 確認」。可以返回上一步或取消。通道可略過、選已設定且未指派的 bot，或點選「新增 Telegram bot」並貼上 BotFather 給的 token。若 OEP 還不知道你的 Telegram 帳號，請在私人聊天室對 bot 傳送 `/start`，再確認顯示的名稱。觸發頁說明通道訊息的處理方式，助理排程將於後續開放。確認後才建立助理、專用資料夾並指派 bot。

助理詳情的通道頁顯示已設定的 token 狀態，可開啟管理視窗更換 token。「新增 Telegram bot」會在同一頁開啟設定視窗，預選目前的助理。詳情的「刪除助理」也可從助理的「更多」開啟，須在對話框確認。刪除會解除 bot 指派並保留會話。有等待或進行中的工作時，請等處理完再刪除。內建助理的詳情會說明無法刪除的原因。

### 助理控制項對照

| 舊位置 | 新位置 | 欄位、操作或狀態 |
|---|---|---|
| 功能欄／助理 | 功能欄／助理 | 新增、頭像、名稱、狀態、開始對話、複製、刪除及還原 | <!-- ui:agent-rail -->
| 新功能 | 中央／建立助理 | 步驟狀態、授權、新增 Telegram bot、Telegram token、Telegram 帳號確認、上一步、下一步、取消與建立 | <!-- ui:agent-wizard -->
| 新功能 | 中央／助理詳情 | 六個頁籤、預設模型、通道回覆語言、新增 Telegram bot、已設定 token、更換 token、儲存、刪除及還原 | <!-- ui:agent-detail -->
| 新功能 | 中央／審核 | 待處理及歷史列的來源助理 | <!-- ui:agent-review-source -->

## 設定

從主功能選擇「設定」，或按 Ctrl + , 開啟中央設定頁。左側依序提供助理、助理與通道、外觀、模型、回合限制、專案與資料夾、整合、輸入、外部工具、執行環境及關於。每次只顯示一個分類。Tab 和 Enter 可選擇分類，800 px 以下改用頁首的原生選單。瀏覽器在重新載入後記住上次分類。外觀中的語言選單會即時切換介面，並在此瀏覽器保留選擇。儲存結果顯示於操作旁。可用「返回對話」或主功能離開設定。

「助理與通道」為每位使用中的主助理或專職助理顯示一列，列出已綁定的 Telegram bot 與收訊狀態，或顯示「尚未設定通道」。每列的「新增 Telegram bot」會預選該助理，並與精靈共用 token 設定流程。未指派的 bot 放在清單末段。每個 bot 的「管理」可改派助理、更換 token、重新檢查或移除 bot。改派需要確認。儲存結果短暫顯示在對應的 bot 或助理列。窄版將 bot 的狀態與操作依序堆疊顯示。

「交辦上限」提供精簡、標準和寬鬆。進階收合區顯示各項上限，時間以分鐘呈現。調整個別上限後，進階會顯示「自訂」。

「能力／MCP」在遠端伺服器編輯器顯示驗證方式。OAuth 用戶端資料和權限範圍在同一表單。儲存後可從伺服器卡片登入、取消登入或登出，狀態顯示在卡片內。匯入 JSON 會將焦點移至貼上欄位，填入設定後將焦點帶回伺服器欄位，供擁有者檢查與補齊。

### 設定控制項對照（定稿）

設定與功能對照以分步 4 的介面為準。瀏覽器驗收逐列檢查控制項，並以合成資料開啟需要有資料或狀態才會出現的操作。

| 舊位置 | 新位置 | 欄位、操作或狀態 |
|---|---|---|
| 設定／助理 | 設定／助理 | 前往主助理詳情 | <!-- ui:settings-assistant-link -->
| 設定／助理 | 主助理詳情／基本 | 助理名稱、自我介紹、助理指示、儲存助理設定及狀態 | <!-- ui:settings-assistant -->
| 設定／助理／進階 | 主助理詳情／基本／進階 | 停用的多助理委派開關及時程提示 | <!-- ui:settings-assistant-advanced -->
| 新功能 | 設定／助理與通道 | 助理列、通道空狀態、指定助理的新增 Telegram bot、每個 bot 的收訊與管理、確認改派、更換 token、重新檢查、移除及儲存狀態 | <!-- ui:settings-channels -->
| 設定／助理與通道／交辦額度 | 設定／助理與通道／交辦上限 | 精簡、標準、寬鬆、進階自訂、分鐘、儲存及狀態 | <!-- ui:settings-delegation-limit -->
| 設定／外觀 | 設定／外觀 | 主題（跟隨系統、淺色、深色）、顯示密度（寬鬆、緊湊）、語言（繁體中文、英文） | <!-- ui:settings-appearance-theme -->
| 設定／外觀 | 主助理詳情／基本 | 上傳頭像、還原預設頭像、儲存及狀態 | <!-- ui:settings-appearance-avatar -->
| 設定／外觀 | 設定／外觀 | 儲存外觀及狀態 | <!-- ui:settings-appearance-save -->
| 設定／模型 | 設定／模型 | 模型勾選、新會話預設模型選單、未儲存提示、儲存並套用、立即套用、立即重新檢查及狀態 | <!-- ui:settings-model-controls -->
| 設定／模型 | 設定／模型 | 憑證設定狀態、各模型檢查結果 | <!-- ui:settings-model-status -->
| 設定／模型 | 設定／模型／進階 | 閘道維運說明 | <!-- ui:settings-model-advanced -->
| 設定／回合限制 | 設定／回合限制 | 最近訊息則數、歷史容量上限、工具呼叫次數上限、回合時限、欄位範圍、儲存回合限制及狀態 | <!-- ui:settings-limits -->
| 設定／專案與資料夾 | 設定／專案與資料夾 | 專案選單、目前工作資料夾、唯讀資料夾清單 | <!-- ui:settings-projects -->
| 設定／專案與資料夾 | 設定／專案與資料夾 | 資料夾路徑、加入、移除及狀態 | <!-- ui:settings-project-folders -->
| 設定／整合說明／知識庫整合 | 設定／整合 | 新會話的知識庫查詢工具、Atlas 網址、儲存知識庫設定及狀態、確認後另開 Atlas | <!-- ui:settings-integration -->
| 設定／整合說明 | 設定／整合／進階 | 組織入口與憑證、SSH、模型閘道、共用資料與資產庫的整合說明 | <!-- ui:settings-integration-advanced -->
| 設定／輸入 | 設定／輸入 | 啟用麥克風語音輸入及狀態 | <!-- ui:settings-input -->
| 設定／MCP／內建知識庫 | 設定／外部工具／內建知識庫 | 連線狀態、工具摘要、前往整合管理知識庫查詢工具 | <!-- ui:settings-mcp-knowledge -->
| 設定／外部工具 | 設定／外部工具 | 前往「能力」管理自訂工具 | <!-- ui:settings-mcp-link -->
| 設定／MCP／自訂伺服器 | 能力／MCP／自訂伺服器 | 清單、連線及啟用狀態、適用專案、資料範圍、新增、編輯、啟用／停用、測試連線、移除、匯入 JSON、OAuth 登入、登出及操作結果 | <!-- ui:settings-mcp-list -->
| 設定／MCP／測試連線結果 | 能力／MCP／測試連線結果 | 工具清單、工具說明、啟用／停用個別工具 | <!-- ui:settings-mcp-tools -->
| 設定／MCP／重新啟動提示 | 能力／MCP／重新啟動提示 | 重新啟動執行環境及狀態 | <!-- ui:settings-mcp-restart -->
| 設定／MCP／伺服器編輯器 | 能力／MCP／伺服器編輯器 | 名稱、連線方式、本機執行檔、參數、工作資料夾、遠端網址、允許本機或私人網路、遠端驗證方式 | <!-- ui:settings-mcp-connection -->
| 設定／MCP／伺服器編輯器 | 能力／MCP／伺服器編輯器 | 新增／移除憑證欄位、名稱、輸入新憑證的勾選及密碼欄位、已設定狀態、OAuth 用戶端註冊、ID、密鑰及權限範圍 | <!-- ui:settings-mcp-credentials -->
| 設定／MCP／伺服器編輯器 | 能力／MCP／伺服器編輯器 | 允許的專案、資料範圍說明、啟用伺服器、儲存、取消及表單狀態 | <!-- ui:settings-mcp-access -->
| 設定／MCP／伺服器編輯器／逾時 | 能力／MCP／伺服器編輯器／進階 | 啟動、工具清單及執行的時間上限 | <!-- ui:settings-mcp-timeouts -->
| 設定／執行環境 | 設定／執行環境 | 固定版本、執行版本、相容性檢查、目前會話助理 | <!-- ui:settings-runtime -->
| 設定／執行環境 | 設定／執行環境／進階 | 提交、介面、Windows 執行檔及用戶端雜湊 | <!-- ui:settings-runtime-advanced -->
| 設定／執行環境 | 設定／整合 | 知識庫設定狀態、Telegram 整合設定狀態（進階）。整合頁也各列一項助理機器人和知識庫機器人的設定狀態 | <!-- ui:settings-integration-status -->
| 設定／關於 | 設定／關於 | OEP 版本、資料目錄、OpenCode 固定版本、授權、使用說明及工作台文件連結 | <!-- ui:settings-about -->

## 知識庫、排程與工作、審核

知識庫的問答把輸入框留在頁末。卡片、引用、來源文字與模型提案使用附加資料分頁。排程與工作在中央呈現工作及排程摘要，各筆排程的操作收在「更多」。審核的待處理清單涵蓋所有知識庫，點選項目查看變更與引文，先核准再發布。審核紀錄保留較早的決定與版本操作。

### 功能控制項對照（定稿）

| 舊位置 | 新位置 | 欄位、操作或狀態 |
|---|---|---|
| 主功能／能力 | 主功能／能力 | 收合時仍可見，開啟後將焦點移至頁首，頁籤支援方向鍵、Home 及 End | <!-- ui:capabilities-navigation -->
| 能力／外掛 | 能力／Plugin | 從檔案安裝、整頁拖放、已安裝清單與狀態，安裝前確認權限 | <!-- ui:capabilities-plugins -->
| 新功能 | 能力／Skill | ZIP 或本機資料夾、來源與說明、助理選單、啟用、超過 20 個時確認、解除安裝 | <!-- ui:capabilities-skills -->
| 新功能 | 能力／Workflow | 匯入 AEP JSON、唯讀步驟及參數、執行功能即將推出 | <!-- ui:capabilities-workflows -->
| 知識庫／建置 | 能力／知識庫 | 已發布套件、BI 匯出資料夾、模型同意、版本、來源及移除，於助理詳情綁定 | <!-- ui:capabilities-knowledge -->
| 設定／外部工具 | 能力／MCP | 自訂伺服器、信任及重新信任本機 stdio 工具、助理與工作區授權 | <!-- ui:capabilities-mcp -->
| 知識庫／內容上方 | 知識庫／頁首 | 已發布知識庫選單、讀取與可搜尋狀態、概覽／問答／品質／建置頁籤 | <!-- ui:feature-knowledge-header -->
| 知識庫／概覽 | 知識庫／概覽 | 發布標籤、發布時間、卡片／來源／證據／關係數量、空狀態 | <!-- ui:feature-knowledge-overview -->
| 知識庫／概覽 | 知識庫／概覽／進階 | 知識庫識別碼、發布版本、結構版本、索引狀態 | <!-- ui:feature-knowledge-advanced -->
| 知識庫／概覽／索引維護 | 知識庫／概覽／進階 | 重建索引、確認與操作狀態 | <!-- ui:feature-knowledge-index -->
| 知識庫／概覽 | 知識庫／概覽／更多 | 載入及移除範例知識庫、允許範例供模型回答、操作狀態 | <!-- ui:feature-knowledge-sample -->
| 知識庫／卡片預覽 | 知識庫／概覽／卡片預覽 | 名稱或識別鍵、類型、分類、領域／資料夾、範例／一般資料、篩選、六欄排序、上一頁／下一頁、筆數和卡片開啟 | <!-- ui:feature-knowledge-cards -->
| 知識庫／段落全文搜尋 | 知識庫／概覽／段落全文搜尋 | 搜尋詞、搜尋段落、符合段落與醒目提示、開啟來源 | <!-- ui:feature-knowledge-search -->
| 知識庫／卡片抽屜 | 附加資料／卡片 | 欄位、欄位出處及狀態、引文與來源分頁、關聯卡片雙向連結、進階中的卡片識別資訊、欄位變更及發布紀錄 | <!-- ui:feature-knowledge-card -->
| 知識庫／問答 | 知識庫／問答／頁末 | 問題欄位、詢問知識庫、讀取／拒答／驗證狀態、答案、知識庫與標籤、進階中的發布版本 | <!-- ui:feature-knowledge-ask -->
| 知識庫／問答、搜尋或品質／來源抽屜 | 附加資料／來源段落 | 來源與定位、段落、搜尋相符文字、進階中的問答引用來源版本、開啟卡片 | <!-- ui:feature-knowledge-source -->
| 知識庫／品質 | 知識庫／品質 | 題集、執行／取消、執行狀態、標準題集使用條件、逐題結果及答案／理由／引用、進階評分中的各項門檻與 D03 結果 | <!-- ui:feature-quality-results -->
| 知識庫／品質／題集操作 | 知識庫／品質／進階 | 核准模型、新題集名稱、新增／刪除題集、從檔案載入或編輯 JSON、匯入並取代題目、匯出題集 | <!-- ui:feature-quality-sets -->
| 知識庫／品質／題目 | 知識庫／品質／題目與編輯題目 | 題目清單、逐題編輯／刪除、問題、預期答案、類別、搜尋與選取／移除證據、開啟段落、儲存題目、新增另一題 | <!-- ui:feature-quality-editor -->
| 知識庫／建置／儲存庫匯入 | 知識庫／建置／從本機資料夾匯入 | 完整路徑、模型使用同意、檢查資料夾、匯入發布版本、處理狀態與進階診斷 | <!-- ui:feature-build-repository -->
| 知識庫／建置／BI 與 Wiki 匯入與審核 | 知識庫／建置／從來源建立卡片或文章 | 知識庫代號與建議選項、載入既有庫、選取檔案、貼上來源、載入來源至草稿、查看來源文字、附加資料內唯讀來源和引文選取 | <!-- ui:feature-build-source -->
| 知識庫／建置／BI 與 Wiki 建置設定 | 知識庫／建置／各來源區的進階 | Schema 版本、卡片必要欄位、安裝 Schema 並建立草稿範本、候選 JSON、送交 JSON 審核 | <!-- ui:feature-build-format -->
| 知識庫／建置／BI 卡片變更 | 知識庫／建置／從來源建立卡片 | 新增卡片、保留／變更／移除或新增／略過、卡片標題、欄位值、引文、採用選取文字 | <!-- ui:feature-build-card -->
| 知識庫／建置／BI 與 Wiki 送審 | 知識庫／建置及附加資料 | 送交審核、查看已送審草稿、產生模型提案與傳送說明、操作狀態、提案分頁 | <!-- ui:feature-build-submit -->
| 工作與排程／重新整理 | 排程與工作／中央工具列 | 重新整理與操作狀態、新增排程、總執行紀錄 | <!-- ui:feature-jobs-toolbar -->
| 工作與排程／工作狀態 | 排程與工作／工作列及附加資料 | 工作狀態、點選查看工作代號、未完成工作從更多立即執行 | <!-- ui:feature-jobs-work -->
| 工作與排程／每日排程 | 排程與工作／排程列 | 排程名稱、狀態、下次執行、點選開啟詳細資料、更多中的編輯／核准／拒絕／暫停／恢復／移除／立即執行 | <!-- ui:feature-jobs-schedule -->
| 工作與排程／每日排程表單 | 附加資料／新增或編輯排程 | 排程名稱、當地時間、時區、進階工作參數、儲存待核准排程、立即送出工作、參數驗證 | <!-- ui:feature-jobs-editor -->
| 工作與排程／執行紀錄 | 附加資料／執行紀錄 | 總紀錄及從個別排程詳情進入的紀錄、執行時間、狀態、進階時間與時區資料 | <!-- ui:feature-jobs-history -->
| 工作與排程／BI Telegram 收件 | 排程與工作／更多／Telegram 收件 | 兩個機器人設定狀態、收件狀態篩選、符合筆數、開啟收件、進階設定領域／核准來源／目標知識庫、儲存設定 | <!-- ui:feature-jobs-inbox -->
| 工作與排程／BI Telegram 收件／單筆 | 附加資料／收件 | 收件狀態、進階來源／目標／原因、下載來源、補件文字與送審 | <!-- ui:feature-jobs-source -->
| 工作與排程／工作狀態／通知與收件失敗 | 附加資料／通知紀錄 | 機器人、通知分組狀態與筆數、需核對通知與嘗試次數、進階通知代號、手動重送與重複通知確認、失敗收件與時間 | <!-- ui:feature-jobs-delivery -->
| 建置／BI 與 Wiki 審核清單 | 審核／待處理、審核紀錄、匯入工作 | 重新整理清單、卡片與文章、待審核與核准待發布、歷史狀態、匯入工作代號與立即執行 | <!-- ui:feature-review-list -->
| 建置／單筆審核 | 附加資料／審核項目 | 比較版本與證據、變更摘要、來源定位、引文、草稿查詢與搜尋結果 | <!-- ui:feature-review-comparison -->
| 建置／單筆審核／進階 | 附加資料／審核項目／進階 | 審核代號、前一版本及發布版本、草稿 JSON、儲存修訂、非待審稿唯讀 | <!-- ui:feature-review-editor -->
| 建置／單筆審核／決定 | 附加資料／審核項目 | 核准、拒絕、文章捨棄草稿、另一步發布、更多中的回復前一版本與重新啟用、操作狀態 | <!-- ui:feature-review-actions -->
| 來源抽屜／關閉 | 附加資料／分頁及區域 | 分頁關閉、關閉附加資料、窄版返回頁面、Esc、方向鍵切換及焦點還原 | <!-- ui:feature-preview-close -->
| 交辦結果 | 對話／主助理訊息下方 | 專職名稱、狀態、未讀、摘要、標為已讀、查看執行紀錄、匯出檔案預覽及下載 | <!-- ui:delegation-card -->
| 交辦取消 | 對話／交辦結果卡 | 取消交辦、確認與取消後狀態 | <!-- ui:delegation-cancel -->
| 交辦執行 | 附加資料／執行紀錄 | 執行與效果時間線、模型、工具活動、交辦對話及匯出檔案 | <!-- ui:delegation-run -->
| BI 交辦 | 對話／交辦結果卡及附加資料／執行紀錄 | 已送審、查看審核、下載收件來源、發布通知 | <!-- ui:delegation-bi -->

## 附加資料

- 點選對話中的檔案，或選取工作台選單中的「檔案」、「工作」、「變更對照」、「筆記」，即可開啟分頁。訊息操作另提供「查看會話筆記」。在訊息選單或會話筆記列可刪除筆記，原有評分仍會保留。
- 本機參照在對話與檔案清單中顯示箭頭圖示，停留可查看本機路徑。檔案清單提供預覽、在檔案總管中顯示、移除，以及「進階」中的分級與重新確認。預覽顯示第一段文字或第一批資料夾項目。
- 每個分頁可以關閉。關閉最後一頁會釋放右側空間，中央內容會展開。切換會話、切到另一個主頁面或重新載入時，會清除當前開啟的分頁。
- 「查看執行紀錄」會開啟專職助理的唯讀紀錄，並保留中央的主助理對話。開啟終態紀錄或「標為已讀」會清除未讀標記。BI 審核與匯出檔案可從結果卡或執行紀錄開啟。
- Markdown、XLSX／CSV、圖片及變更對照沿用既有的預覽。HTML、工程設定檔及原始碼以等寬字型顯示原始文字。檔案可下載原始內容。適用時可另開既有預覽網址，XLSX 會開啟轉出的表格文字。PDF 提供檔案資料與下載。
- 900 px 以下，附加資料覆蓋整個視窗，底下的功能欄與中央內容暫停接收輸入。「返回對話」或「返回頁面」會關閉覆蓋畫面並還原焦點。
- Tab 可到達功能欄、分頁及關閉按鈕。方向鍵與 Home／End 選擇分頁，Delete 關閉目前分頁，Esc 關閉整區並將焦點交還開啟控制項。

## 版面樣張

樣張使用合成資料。寬版為 1440 × 900，窄版為 390 × 844。

### 0.6.0 擁有者驗收第二輪

| 畫面 | 繁中寬版 | 英文窄版 |
|---|---|---|
| 設定／助理與通道 | [PNG](validation/gui/owner-round2-channels-zh-TW-wide-light.png) | [PNG](validation/gui/owner-round2-channels-en-narrow-dark.png) |
| 設定／新增 Telegram bot | [PNG](validation/gui/owner-round2-channel-setup-zh-TW-wide-light.png) | [PNG](validation/gui/owner-round2-channel-setup-en-narrow-dark.png) |
| 助理詳情／通道 | [PNG](validation/gui/owner-round2-detail-channel-zh-TW-wide-light.png) | [PNG](validation/gui/owner-round2-detail-channel-en-narrow-dark.png) |
| 建立助理／通道 | [PNG](validation/gui/owner-round2-wizard-channel-zh-TW-wide-light.png) | [PNG](validation/gui/owner-round2-wizard-channel-en-narrow-dark.png) |
| 附加資料／會話筆記 | [PNG](validation/gui/owner-round2-notes-zh-TW-wide.png) | [PNG](validation/gui/owner-round2-notes-en-narrow.png) |
| 附加資料／工程附件原始文字 | [PNG](validation/gui/owner-round2-text-preview-zh-TW-wide.png) | [PNG](validation/gui/owner-round2-text-preview-en-narrow.png) |
| 對話／巢狀清單 | [PNG](validation/gui/owner-round2-markdown-zh-TW-wide.png) | [PNG](validation/gui/owner-round2-markdown-en-narrow.png) |

### 其他繁中樣張

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 對話 | [PNG](validation/gui/conversation-light-wide.png) | [PNG](validation/gui/conversation-dark-wide.png) | [PNG](validation/gui/conversation-light-narrow.png) | [PNG](validation/gui/conversation-dark-narrow.png) |
| 對話與 Excel 檔案 | [PNG](validation/gui/conversation-artifact-light-wide.png) | [PNG](validation/gui/conversation-artifact-dark-wide.png) | [PNG](validation/gui/conversation-artifact-light-narrow.png) | [PNG](validation/gui/conversation-artifact-dark-narrow.png) |
| 交辦結果卡 | [PNG](validation/gui/slice6-cards-zh-TW-wide-light.png) | [PNG](validation/gui/slice6-cards-zh-TW-wide-dark.png) | [PNG](validation/gui/slice6-cards-zh-TW-narrow-light.png) | [PNG](validation/gui/slice6-cards-zh-TW-narrow-dark.png) |
| 交辦執行紀錄 | [PNG](validation/gui/slice6-run-zh-TW-wide-light.png) | [PNG](validation/gui/slice6-run-zh-TW-wide-dark.png) | [PNG](validation/gui/slice6-run-zh-TW-narrow-light.png) | [PNG](validation/gui/slice6-run-zh-TW-narrow-dark.png) |
| 設定／助理 | [PNG](validation/gui/settings-assistant-light-wide.png) | [PNG](validation/gui/settings-assistant-dark-wide.png) | [PNG](validation/gui/settings-assistant-light-narrow.png) | [PNG](validation/gui/settings-assistant-dark-narrow.png) |
| 設定／外觀 | [PNG](validation/gui/settings-appearance-light-wide.png) | [PNG](validation/gui/settings-appearance-dark-wide.png) | [PNG](validation/gui/settings-appearance-light-narrow.png) | [PNG](validation/gui/settings-appearance-dark-narrow.png) |
| 設定／模型 | [PNG](validation/gui/settings-model-light-wide.png) | [PNG](validation/gui/settings-model-dark-wide.png) | [PNG](validation/gui/settings-model-light-narrow.png) | [PNG](validation/gui/settings-model-dark-narrow.png) |
| 設定／回合限制 | [PNG](validation/gui/settings-limits-light-wide.png) | [PNG](validation/gui/settings-limits-dark-wide.png) | [PNG](validation/gui/settings-limits-light-narrow.png) | [PNG](validation/gui/settings-limits-dark-narrow.png) |
| 設定／專案與資料夾 | [PNG](validation/gui/settings-projects-light-wide.png) | [PNG](validation/gui/settings-projects-dark-wide.png) | [PNG](validation/gui/settings-projects-light-narrow.png) | [PNG](validation/gui/settings-projects-dark-narrow.png) |
| 設定／整合 | [PNG](validation/gui/settings-integrations-light-wide.png) | [PNG](validation/gui/settings-integrations-dark-wide.png) | [PNG](validation/gui/settings-integrations-light-narrow.png) | [PNG](validation/gui/settings-integrations-dark-narrow.png) |
| 設定／輸入 | [PNG](validation/gui/settings-input-light-wide.png) | [PNG](validation/gui/settings-input-dark-wide.png) | [PNG](validation/gui/settings-input-light-narrow.png) | [PNG](validation/gui/settings-input-dark-narrow.png) |
| 設定／外部工具 | [PNG](validation/gui/settings-mcp-light-wide.png) | [PNG](validation/gui/settings-mcp-dark-wide.png) | [PNG](validation/gui/settings-mcp-light-narrow.png) | [PNG](validation/gui/settings-mcp-dark-narrow.png) |
| 設定／執行環境 | [PNG](validation/gui/settings-runtime-light-wide.png) | [PNG](validation/gui/settings-runtime-dark-wide.png) | [PNG](validation/gui/settings-runtime-light-narrow.png) | [PNG](validation/gui/settings-runtime-dark-narrow.png) |
| 設定／關於 | [PNG](validation/gui/settings-about-light-wide.png) | [PNG](validation/gui/settings-about-dark-wide.png) | [PNG](validation/gui/settings-about-light-narrow.png) | [PNG](validation/gui/settings-about-dark-narrow.png) |
| 知識庫／概覽 | [PNG](validation/gui/slice3a-overview-light-wide.png) | [PNG](validation/gui/slice3a-overview-dark-wide.png) | [PNG](validation/gui/slice3a-overview-light-narrow.png) | [PNG](validation/gui/slice3a-overview-dark-narrow.png) |
| 知識庫／問答 | [PNG](validation/gui/slice3a-ask-light-wide.png) | [PNG](validation/gui/slice3a-ask-dark-wide.png) | [PNG](validation/gui/slice3a-ask-light-narrow.png) | [PNG](validation/gui/slice3a-ask-dark-narrow.png) |
| 知識庫／品質 | [PNG](validation/gui/slice3a-quality-light-wide.png) | [PNG](validation/gui/slice3a-quality-dark-wide.png) | [PNG](validation/gui/slice3a-quality-light-narrow.png) | [PNG](validation/gui/slice3a-quality-dark-narrow.png) |
| 知識庫／建置 | [PNG](validation/gui/slice3a-build-light-wide.png) | [PNG](validation/gui/slice3a-build-dark-wide.png) | [PNG](validation/gui/slice3a-build-light-narrow.png) | [PNG](validation/gui/slice3a-build-dark-narrow.png) |
| 知識庫／卡片 | [PNG](validation/gui/slice3a-drawer-light-wide.png) | [PNG](validation/gui/slice3a-drawer-dark-wide.png) | [PNG](validation/gui/slice3a-drawer-light-narrow.png) | [PNG](validation/gui/slice3a-drawer-dark-narrow.png) |
| 排程與工作 | [PNG](validation/gui/jobs-list-light-wide.png) | [PNG](validation/gui/jobs-list-dark-wide.png) | [PNG](validation/gui/jobs-list-light-narrow.png) | [PNG](validation/gui/jobs-list-dark-narrow.png) |
| 排程／執行紀錄 | [PNG](validation/gui/jobs-details-light-wide.png) | [PNG](validation/gui/jobs-details-dark-wide.png) | [PNG](validation/gui/jobs-details-light-narrow.png) | [PNG](validation/gui/jobs-details-dark-narrow.png) |
| 審核／待處理 | [PNG](validation/gui/review-list-light-wide.png) | [PNG](validation/gui/review-list-dark-wide.png) | [PNG](validation/gui/review-list-light-narrow.png) | [PNG](validation/gui/review-list-dark-narrow.png) |
| 審核／項目 | [PNG](validation/gui/review-item-light-wide.png) | [PNG](validation/gui/review-item-dark-wide.png) | [PNG](validation/gui/review-item-light-narrow.png) | [PNG](validation/gui/review-item-dark-narrow.png) |

### 英文樣張

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 對話 | [PNG](validation/gui/conversation-light-wide-en.png) | [PNG](validation/gui/conversation-dark-wide-en.png) | [PNG](validation/gui/conversation-light-narrow-en.png) | [PNG](validation/gui/conversation-dark-narrow-en.png) |
| 對話與 Excel 檔案 | [PNG](validation/gui/conversation-artifact-light-wide-en.png) | [PNG](validation/gui/conversation-artifact-dark-wide-en.png) | [PNG](validation/gui/conversation-artifact-light-narrow-en.png) | [PNG](validation/gui/conversation-artifact-dark-narrow-en.png) |
| 交辦結果卡 | [PNG](validation/gui/slice6-cards-en-wide-light.png) | [PNG](validation/gui/slice6-cards-en-wide-dark.png) | [PNG](validation/gui/slice6-cards-en-narrow-light.png) | [PNG](validation/gui/slice6-cards-en-narrow-dark.png) |
| 交辦執行紀錄 | [PNG](validation/gui/slice6-run-en-wide-light.png) | [PNG](validation/gui/slice6-run-en-wide-dark.png) | [PNG](validation/gui/slice6-run-en-narrow-light.png) | [PNG](validation/gui/slice6-run-en-narrow-dark.png) |
| 設定／外觀 | [PNG](validation/gui/settings-appearance-light-wide-en.png) | [PNG](validation/gui/settings-appearance-dark-wide-en.png) | [PNG](validation/gui/settings-appearance-light-narrow-en.png) | [PNG](validation/gui/settings-appearance-dark-narrow-en.png) |
| 設定／模型 | [PNG](validation/gui/settings-model-light-wide-en.png) | [PNG](validation/gui/settings-model-dark-wide-en.png) | [PNG](validation/gui/settings-model-light-narrow-en.png) | [PNG](validation/gui/settings-model-dark-narrow-en.png) |
| 知識庫 | [PNG](validation/gui/slice3a-overview-light-wide-en.png) | [PNG](validation/gui/slice3a-overview-dark-wide-en.png) | [PNG](validation/gui/slice3a-overview-light-narrow-en.png) | [PNG](validation/gui/slice3a-overview-dark-narrow-en.png) |
| 排程與工作 | [PNG](validation/gui/jobs-list-light-wide-en.png) | [PNG](validation/gui/jobs-list-dark-wide-en.png) | [PNG](validation/gui/jobs-list-light-narrow-en.png) | [PNG](validation/gui/jobs-list-dark-narrow-en.png) |
| 審核 | [PNG](validation/gui/review-list-light-wide-en.png) | [PNG](validation/gui/review-list-dark-wide-en.png) | [PNG](validation/gui/review-list-light-narrow-en.png) | [PNG](validation/gui/review-list-dark-narrow-en.png) |

窄版執行中的交辦卡片：[繁中淺色](validation/gui/slice6-running-zh-TW-narrow-light.png)、[繁中深色](validation/gui/slice6-running-zh-TW-narrow-dark.png)、[英文淺色](validation/gui/slice6-running-en-narrow-light.png)、[英文深色](validation/gui/slice6-running-en-narrow-dark.png)。

## 能力頁上線前的版面紀錄

```text
| 在設定登錄的自訂連線與工具 | 外部工具 | External Tools |

- **主功能**包含對話、知識庫、排程與工作、審核、設定。審核列出各知識庫的卡片與文章草稿。

- 助理、設定、知識庫、排程與工作、審核各自使用中央區域。知識庫頁首保留已發布知識庫選單和搜尋狀態。概覽、問答、品質與建置每次顯示一頁，方向鍵可切換。重新載入後再次開啟知識庫，會恢復上一次使用的頁籤與仍可用的知識庫。

詳情使用「基本、模型、知識庫、通道、觸發、能力」六個頁籤。方向鍵切換頁籤，Home 和 End 跳到首尾。基本頁顯示工作資料夾與已匯入的唯讀資料夾。模型可跟隨全域預設，也可從已選清單指定。知識庫可勾選已發布的讀取來源，並列出只能用提案送審的目標。通道頁可修改回覆語言，能力頁顯示外部工具授權與暫停狀態，Skill 將在 3E 開放。

「外部工具」在遠端伺服器編輯器顯示驗證方式。OAuth 用戶端資料和權限範圍在同一表單。儲存後可從伺服器卡片登入、取消登入或登出，狀態顯示在卡片內。匯入 JSON 會將焦點移至貼上欄位，填入設定後將焦點帶回伺服器欄位，供擁有者檢查與補齊。

| 設定／MCP／自訂伺服器 | 設定／外部工具／自訂伺服器 | 清單、連線及啟用狀態、適用專案、資料範圍、新增、編輯、啟用／停用、測試連線、移除、匯入 JSON、OAuth 登入、登出及操作結果 | <!-- ui:settings-mcp-list -->

| 設定／MCP／測試連線結果 | 設定／外部工具／測試連線結果 | 工具清單、工具說明、啟用／停用個別工具 | <!-- ui:settings-mcp-tools -->

| 設定／MCP／重新啟動提示 | 設定／外部工具／重新啟動提示 | 重新啟動執行環境及狀態 | <!-- ui:settings-mcp-restart -->

| 設定／MCP／伺服器編輯器 | 設定／外部工具／伺服器編輯器 | 名稱、連線方式、本機執行檔、參數、工作資料夾、遠端網址、允許本機或私人網路、遠端驗證方式 | <!-- ui:settings-mcp-connection -->

| 設定／MCP／伺服器編輯器 | 設定／外部工具／伺服器編輯器 | 新增／移除憑證欄位、名稱、輸入新憑證的勾選及密碼欄位、已設定狀態、OAuth 用戶端註冊、ID、密鑰及權限範圍 | <!-- ui:settings-mcp-credentials -->

| 設定／MCP／伺服器編輯器 | 設定／外部工具／伺服器編輯器 | 允許的專案、資料範圍說明、啟用伺服器、儲存、取消及表單狀態 | <!-- ui:settings-mcp-access -->

| 設定／MCP／伺服器編輯器／逾時 | 設定／外部工具／伺服器編輯器／進階 | 啟動、工具清單及執行的時間上限 | <!-- ui:settings-mcp-timeouts -->
```
