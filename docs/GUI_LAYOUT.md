# OEP 工作台版面規格

2026-11-22（Asia/Taipei）。Phase 2b 外殼沿用 OEP 的色票、字型、顯示密度與系統、淺色、深色主題。 [重做藍圖](GUI_REDESIGN_BLUEPRINT.md) · [外殼驗收](reviews/PHASE2B_SHELL_V2_REPORT.md)

## 功能欄

- 頂端顯示助理的頭像、名稱及一行自我介紹，取自既有助理及外觀設定。
- **主功能**包含對話、知識庫、排程與工作、審核、設定。審核列出各知識庫的卡片與文章草稿。
- **會話**顯示目前專案的會話數。依專案分組，可搜尋會話、用「＋」新增，以及從會話的「⋯」選單重新命名或刪除。
- **助理**顯示可供新會話使用的助理數量及選擇器。
- 三個區塊各自收合。瀏覽器在重新載入後保留各區塊的狀態。540 px 以下以「功能導覽」按鈕開啟整欄。

## 中央內容

- 頂列左側顯示目前模型、模型來源與對話的處理狀態。右側顯示本機使用身分及連線狀態。頂列的「⋯」是工作台選單，包含「停止服務」及對話的附加資料入口。
- 訊息區可捲動。離開最新訊息時，可用「跳到最新訊息」返回。對話下方的會話檔案按鈕可直接預覽附件及產出。
- 輸入框支援選取或拖放附件。可從「已選附件」勾選下一則要傳送的檔案，或選用既有的唯讀資料夾與語音輸入。模型選單標示設定預設值，切換從下一則訊息生效。「停止處理」結束當前回合。下方固定顯示 Enter 送出與 Shift + Enter 換行的提示，中文輸入法組字時可用 Enter 確認選字。
- 設定、知識庫、排程與工作、審核各自使用中央區域。知識庫頁首保留已發布知識庫選單和搜尋狀態。概覽、問答、品質與建置每次顯示一頁，方向鍵可切換。重新載入後再次開啟知識庫，會恢復上一次使用的頁籤與仍可用的知識庫。

## 設定

從主功能選擇「設定」，或按 Ctrl + , 開啟中央設定頁。左側依序提供助理、外觀、模型、回合限制、專案與資料夾、整合、輸入、MCP、執行環境及關於。每次只顯示一個分類。Tab 和 Enter 可選擇分類，760 px 以下改用頁首的原生選單。瀏覽器在重新載入後記住上次分類。儲存結果顯示於操作旁。可用「返回對話」或主功能離開設定。

### 既有設定控制項對照

下表涵蓋外殼第二版設定內的欄位、操作和狀態。對話輸入框的模型、唯讀檔案及開始聽寫按鈕仍位於對話。

| 舊位置 | 新位置 | 欄位、操作或狀態 |
|---|---|---|
| 設定／助理 | 設定／助理 | 助理名稱、自我介紹、助理指示、儲存助理設定及狀態 |
| 設定／助理 | 設定／助理／進階 | 停用的多助理委派開關及原因 |
| 設定／外觀 | 設定／外觀 | 主題（跟隨系統、淺色、深色）、顯示密度（寬鬆、緊湊） |
| 設定／外觀 | 設定／外觀 | 上傳頭像、還原預設頭像、儲存外觀及狀態 |
| 設定／模型 | 設定／模型 | 新會話預設模型選單、儲存預設模型、立即重新檢查及狀態 |
| 設定／模型 | 設定／模型 | 憑證設定狀態、各模型檢查結果 |
| 設定／模型 | 設定／模型／進階 | 閘道維運說明 |
| 設定／回合限制 | 設定／回合限制 | 最近訊息則數、歷史容量上限、工具呼叫次數上限、回合時限、欄位範圍、儲存回合限制及狀態 |
| 設定／專案與資料夾 | 設定／專案與資料夾 | 專案選單、目前工作資料夾、唯讀資料夾清單 |
| 設定／專案與資料夾 | 設定／專案與資料夾 | 資料夾路徑、加入、移除及狀態 |
| 設定／整合說明／知識庫整合 | 設定／整合 | 新會話的 BI 查詢工具、Atlas 網址、儲存知識庫設定及狀態、確認後另開 Atlas |
| 設定／整合說明 | 設定／整合／進階 | 組織入口與憑證、SSH、模型閘道、共用資料與資產庫的整合說明 |
| 設定／輸入 | 設定／輸入 | 啟用麥克風語音輸入及狀態 |
| 設定／MCP／內建知識庫 | 設定／MCP／內建知識庫 | 連線狀態、工具摘要、前往整合管理 BI 查詢工具 |
| 設定／MCP／自訂伺服器 | 設定／MCP／自訂伺服器 | 清單、連線及啟用狀態、適用專案、資料範圍、新增、編輯、啟用／停用、測試連線、移除及操作結果 |
| 設定／MCP／測試連線結果 | 設定／MCP／測試連線結果 | 工具清單、工具說明、啟用／停用個別工具 |
| 設定／MCP／重新啟動提示 | 設定／MCP／重新啟動提示 | 重新啟動執行環境及狀態 |
| 設定／MCP／伺服器編輯器 | 設定／MCP／伺服器編輯器 | 名稱、連線方式、本機執行檔、參數、工作資料夾、遠端網址、允許本機或私人網路 |
| 設定／MCP／伺服器編輯器 | 設定／MCP／伺服器編輯器 | 新增／移除憑證欄位、名稱、輸入新憑證的勾選及密碼欄位、已設定狀態 |
| 設定／MCP／伺服器編輯器 | 設定／MCP／伺服器編輯器 | 允許的專案、資料範圍說明、啟用伺服器、儲存、取消及表單狀態 |
| 設定／MCP／伺服器編輯器／逾時 | 設定／MCP／伺服器編輯器／進階 | 啟動、工具清單及執行的時間上限 |
| 設定／執行環境 | 設定／執行環境 | 固定版本、執行版本、相容性檢查、目前會話助理 |
| 設定／執行環境 | 設定／執行環境／進階 | 提交、介面、Windows 執行檔及用戶端雜湊 |
| 設定／執行環境 | 設定／整合 | 知識庫設定狀態、Telegram 整合設定狀態（進階）。整合頁也各列一項助理機器人和 BI 機器人的設定狀態 |
| 設定／關於 | 設定／關於 | OEP 版本、資料目錄、OpenCode 固定版本、授權、使用說明及工作台文件連結 |

## 知識庫、排程與工作、審核

知識庫的問答把輸入框留在頁末。卡片、引用、來源文字與模型提案使用附加資料分頁。排程與工作在中央呈現工作及排程摘要，各筆排程的操作收在「更多」。審核的待處理清單涵蓋所有知識庫，點選項目查看變更與引文，先核准再發布。審核紀錄保留較早的決定與版本操作。

### 既有功能控制項對照

| 舊位置 | 新位置 | 欄位、操作或狀態 |
|---|---|---|
| 知識庫／內容上方 | 知識庫／頁首 | 已發布知識庫選單、讀取與可搜尋狀態、概覽／問答／品質／建置頁籤 |
| 知識庫／概覽 | 知識庫／概覽 | 發布標籤、發布時間、卡片／來源／證據／關係數量、空狀態 |
| 知識庫／概覽 | 知識庫／概覽／進階 | 知識庫識別碼、發布版本、結構版本、索引狀態 |
| 知識庫／概覽／索引維護 | 知識庫／概覽／進階 | 重建索引、確認與操作狀態 |
| 知識庫／概覽 | 知識庫／概覽／更多 | 載入及移除範例知識庫、允許範例供模型回答、操作狀態 |
| 知識庫／卡片預覽 | 知識庫／概覽／卡片預覽 | 名稱或識別鍵、類型、分類、領域／資料夾、範例／一般資料、篩選、六欄排序、上一頁／下一頁、筆數和卡片開啟 |
| 知識庫／段落全文搜尋 | 知識庫／概覽／段落全文搜尋 | 搜尋詞、搜尋段落、符合段落與醒目提示、開啟來源 |
| 知識庫／卡片抽屜 | 附加資料／卡片 | 欄位、欄位出處及狀態、引文與來源分頁、關聯卡片雙向連結、進階中的卡片識別資訊、欄位變更及發布紀錄 |
| 知識庫／問答 | 知識庫／問答／頁末 | 問題欄位、詢問知識庫、讀取／拒答／驗證狀態、答案、知識庫與標籤、進階中的發布版本 |
| 知識庫／問答、搜尋或品質／來源抽屜 | 附加資料／來源段落 | 來源與定位、段落、相符文字、進階中的來源版本、開啟卡片 |
| 知識庫／品質 | 知識庫／品質 | 題集、執行／取消、執行狀態、標準題集使用條件、逐題結果及答案／理由／引用、進階評分中的各項門檻與 D03 結果 |
| 知識庫／品質／題集操作 | 知識庫／品質／進階 | 核准模型、新題集名稱、新增／刪除題集、從檔案載入或編輯 JSON、匯入並取代題目、匯出題集 |
| 知識庫／品質／題目 | 知識庫／品質／題目與編輯題目 | 題目清單、逐題編輯／刪除、問題、預期答案、類別、搜尋與選取／移除證據、開啟段落、儲存題目、新增另一題 |
| 知識庫／建置／儲存庫匯入 | 知識庫／建置／從本機資料夾匯入 | 完整路徑、模型使用同意、檢查資料夾、匯入發布版本、處理狀態與進階診斷 |
| 知識庫／建置／BI 與 Wiki 匯入與審核 | 知識庫／建置／從來源建立卡片或文章 | 知識庫代號與建議選項、載入既有庫、選取檔案、貼上來源、載入來源至草稿、查看來源文字、附加資料內唯讀來源和引文選取 |
| 知識庫／建置／BI 與 Wiki 建置設定 | 知識庫／建置／各來源區的進階 | Schema 版本、卡片必要欄位、安裝 Schema 並建立草稿範本、候選 JSON、送交 JSON 審核 |
| 知識庫／建置／BI 卡片變更 | 知識庫／建置／從來源建立卡片 | 新增卡片、保留／變更／移除或新增／略過、卡片標題、欄位值、引文、採用選取文字 |
| 知識庫／建置／BI 與 Wiki 送審 | 知識庫／建置及附加資料 | 送交審核、查看已送審草稿、產生模型提案與傳送說明、操作狀態、提案分頁 |
| 工作與排程／重新整理 | 排程與工作／中央工具列 | 重新整理與操作狀態、新增排程、總執行紀錄 |
| 工作與排程／工作狀態 | 排程與工作／工作列及附加資料 | 工作狀態、點選查看工作代號、未完成工作從更多立即執行 |
| 工作與排程／每日排程 | 排程與工作／排程列 | 排程名稱、狀態、下次執行、點選開啟詳細資料、更多中的編輯／核准／拒絕／暫停／恢復／移除／立即執行 |
| 工作與排程／每日排程表單 | 附加資料／新增或編輯排程 | 排程名稱、當地時間、時區、進階工作參數、儲存待核准排程、立即送出工作、參數驗證 |
| 工作與排程／執行紀錄 | 附加資料／執行紀錄 | 總紀錄及從個別排程詳情進入的紀錄、執行時間、狀態、進階時間與時區資料 |
| 工作與排程／BI Telegram 收件 | 排程與工作／更多／Telegram 收件 | 兩個機器人設定狀態、收件狀態篩選、符合筆數、開啟收件、進階設定領域／核准來源／目標知識庫、儲存設定 |
| 工作與排程／BI Telegram 收件／單筆 | 附加資料／收件 | 收件狀態、進階來源／目標／原因、下載來源、補件文字與送審 |
| 工作與排程／工作狀態／通知與收件失敗 | 附加資料／通知紀錄 | 機器人、通知分組狀態與筆數、需核對通知與嘗試次數、進階通知代號、手動重送與重複通知確認、失敗收件與時間 |
| 建置／BI 與 Wiki 審核清單 | 審核／待處理、審核紀錄、匯入工作 | 重新整理清單、卡片與文章、待審核與核准待發布、歷史狀態、匯入工作代號與立即執行 |
| 建置／單筆審核 | 附加資料／審核項目 | 比較版本與證據、變更摘要、來源定位、引文、草稿查詢與搜尋結果 |
| 建置／單筆審核／進階 | 附加資料／審核項目／進階 | 審核代號、前一版本及發布版本、草稿 JSON、儲存修訂、非待審稿唯讀 |
| 建置／單筆審核／決定 | 附加資料／審核項目 | 核准、拒絕、文章捨棄草稿、另一步發布、更多中的回復前一版本與重新啟用、操作狀態 |
| 來源抽屜／關閉 | 附加資料／分頁及區域 | 分頁關閉、關閉附加資料、窄版返回頁面、Esc、方向鍵切換及焦點還原 |

## 附加資料

- 點選對話中的檔案，或選取工作台選單中的「檔案與產出」、「工作」、「變更對照」、「筆記」，即可開啟分頁。訊息操作另提供「查看會話筆記」。
- 每個分頁可以關閉。關閉最後一頁會釋放右側空間，中央內容會展開。切換會話、切到另一個主頁面或重新載入時，會清除當前開啟的分頁。
- Markdown、HTML、XLSX／CSV、PNG／JPEG、文字及變更對照沿用既有的預覽。檔案可下載原始內容。適用時可另開既有預覽網址，HTML 會以純文字開啟，XLSX 會開啟轉出的表格文字。PDF 提供檔案資料與下載。
- 900 px 以下，附加資料覆蓋整個視窗，底下的功能欄與中央內容暫停接收輸入。「返回對話」或「返回頁面」會關閉覆蓋畫面並還原焦點。
- Tab 可到達功能欄、分頁及關閉按鈕。方向鍵與 Home／End 選擇分頁，Delete 關閉目前分頁，Esc 關閉整區並將焦點交還開啟控制項。

## 版面樣張

| 畫面 | 淺色寬版 | 深色寬版 | 淺色窄版 | 深色窄版 |
|---|---|---|---|---|
| 對話 | [PNG](validation/gui/conversation-light-wide.png) | [PNG](validation/gui/conversation-dark-wide.png) | [PNG](validation/gui/conversation-light-narrow.png) | [PNG](validation/gui/conversation-dark-narrow.png) |
| 對話與 Excel 產出 | [PNG](validation/gui/conversation-artifact-light-wide.png) | [PNG](validation/gui/conversation-artifact-dark-wide.png) | [PNG](validation/gui/conversation-artifact-light-narrow.png) | [PNG](validation/gui/conversation-artifact-dark-narrow.png) |
| 設定／助理 | [PNG](validation/gui/settings-assistant-light-wide.png) | [PNG](validation/gui/settings-assistant-dark-wide.png) | [PNG](validation/gui/settings-assistant-light-narrow.png) | [PNG](validation/gui/settings-assistant-dark-narrow.png) |
| 設定／外觀 | [PNG](validation/gui/settings-appearance-light-wide.png) | [PNG](validation/gui/settings-appearance-dark-wide.png) | [PNG](validation/gui/settings-appearance-light-narrow.png) | [PNG](validation/gui/settings-appearance-dark-narrow.png) |
| 設定／模型 | [PNG](validation/gui/settings-model-light-wide.png) | [PNG](validation/gui/settings-model-dark-wide.png) | [PNG](validation/gui/settings-model-light-narrow.png) | [PNG](validation/gui/settings-model-dark-narrow.png) |
| 設定／回合限制 | [PNG](validation/gui/settings-limits-light-wide.png) | [PNG](validation/gui/settings-limits-dark-wide.png) | [PNG](validation/gui/settings-limits-light-narrow.png) | [PNG](validation/gui/settings-limits-dark-narrow.png) |
| 設定／專案與資料夾 | [PNG](validation/gui/settings-projects-light-wide.png) | [PNG](validation/gui/settings-projects-dark-wide.png) | [PNG](validation/gui/settings-projects-light-narrow.png) | [PNG](validation/gui/settings-projects-dark-narrow.png) |
| 設定／整合 | [PNG](validation/gui/settings-integrations-light-wide.png) | [PNG](validation/gui/settings-integrations-dark-wide.png) | [PNG](validation/gui/settings-integrations-light-narrow.png) | [PNG](validation/gui/settings-integrations-dark-narrow.png) |
| 設定／輸入 | [PNG](validation/gui/settings-input-light-wide.png) | [PNG](validation/gui/settings-input-dark-wide.png) | [PNG](validation/gui/settings-input-light-narrow.png) | [PNG](validation/gui/settings-input-dark-narrow.png) |
| 設定／MCP | [PNG](validation/gui/settings-mcp-light-wide.png) | [PNG](validation/gui/settings-mcp-dark-wide.png) | [PNG](validation/gui/settings-mcp-light-narrow.png) | [PNG](validation/gui/settings-mcp-dark-narrow.png) |
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
