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
- 設定、知識庫、排程與工作都使用同一中央區域。設定保留頁內分類，知識庫保留概覽、問答、品質與建置。

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
| 設定 | [PNG](validation/gui/settings-assistant-light-wide.png) | [PNG](validation/gui/settings-assistant-dark-wide.png) | [PNG](validation/gui/settings-assistant-light-narrow.png) | [PNG](validation/gui/settings-assistant-dark-narrow.png) |
| 知識庫 | [PNG](validation/gui/slice3a-overview-light-wide.png) | [PNG](validation/gui/slice3a-overview-dark-wide.png) | [PNG](validation/gui/slice3a-overview-light-narrow.png) | [PNG](validation/gui/slice3a-overview-dark-narrow.png) |
