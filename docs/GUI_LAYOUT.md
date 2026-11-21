# OEP 工作台版面規格

2026-11-22（Asia/Taipei）。Phase 2b 外殼沿用 OEP 的色票、字型、顯示密度與系統、淺色、深色主題。 [重做藍圖](GUI_REDESIGN_BLUEPRINT.md) · [外殼驗收](reviews/PHASE2B_SHELL_V2_REPORT.md)

## 功能欄

- 頂端顯示助理的頭像、名稱及一行自我介紹，取自既有助理及外觀設定。
- **主功能**包含對話、知識庫、排程與工作、設定。知識庫提供審核時，審核入口會開啟知識庫的「建置」頁籤及既有審核控制項。
- **會話**顯示目前專案的會話數。依專案分組，可搜尋會話、用「＋」新增，以及從會話的「⋯」選單重新命名或刪除。
- **助理**顯示可供新會話使用的助理數量及選擇器。
- 三個區塊各自收合。瀏覽器在重新載入後保留各區塊的狀態。540 px 以下以「功能導覽」按鈕開啟整欄。

## 中央內容

- 頂列左側顯示目前模型、模型來源與對話的處理狀態。右側顯示本機使用身分及連線狀態。頂列的「⋯」是工作台選單，包含「停止服務」及對話的附加資料入口。
- 訊息區可捲動。離開最新訊息時，可用「跳到最新訊息」返回。對話下方的會話檔案按鈕可直接預覽附件及產出。
- 輸入框支援選取或拖放附件。可從「已選附件」勾選下一則要傳送的檔案，或選用既有的唯讀資料夾與語音輸入。模型選單標示設定預設值，切換從下一則訊息生效。「停止處理」結束當前回合。下方固定顯示 Enter 送出與 Shift + Enter 換行的提示，中文輸入法組字時可用 Enter 確認選字。
- 設定、知識庫、排程與工作都使用同一中央區域。知識庫保留概覽、問答、品質與建置。

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

## 附加資料

- 點選對話中的檔案，或選取工作台選單中的「檔案與產出」、「工作」、「變更對照」、「筆記」，即可開啟分頁。訊息操作另提供「查看會話筆記」。
- 每個分頁可以關閉。關閉最後一頁會釋放右側空間，中央內容會展開。切換會話、切到另一個主頁面或重新載入時，會清除當前開啟的分頁。
- Markdown、HTML、XLSX／CSV、PNG／JPEG、文字及變更對照沿用既有的預覽。檔案可下載原始內容。適用時可另開既有預覽網址，HTML 會以純文字開啟，XLSX 會開啟轉出的表格文字。PDF 提供檔案資料與下載。
- 900 px 以下，附加資料覆蓋整個視窗，底下的功能欄與中央內容暫停接收輸入。「返回對話」會關閉覆蓋畫面。
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
| 知識庫 | [PNG](validation/gui/slice3a-overview-light-wide.png) | [PNG](validation/gui/slice3a-overview-dark-wide.png) | [PNG](validation/gui/slice3a-overview-light-narrow.png) | [PNG](validation/gui/slice3a-overview-dark-narrow.png) |
