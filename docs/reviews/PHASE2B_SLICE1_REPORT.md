# Phase 2b Slice 1 工作台驗收

## 已實作

- 會話搜尋、重新命名、刪除確認及重載後恢復選擇。刪除會將目標從 Web 清單與新請求中移除，保留資料庫稽核及既有磁碟資料。
- 會話導覽、檔案與產物、即時進度可收合。設定集中在左欄，保留既有知識庫、審核及工作入口。
- 系統、淺色與深色主題保存於瀏覽器。助理名稱、自介與指示透過既有同源認證及 CSRF 保護儲存於 SQLite。助理設定以回合送出時間擷取，舊指示可能留在上游對話歷史中。
- 顯示 OpenCode 版本、連線及模型別名。整合說明涵蓋公司橋接、SSH 決策、閘道管理、共享資產與資料集。多助理委派入口停用。

## 驗收

- **VERIFIED** Chromium 合成 PNG、PDF、XLSX 對話，產物下載雜湊，助理設定儲存與重載，會話搜尋、改名、取消與確認刪除，移除後回 404，主題持久化及窄版無橫向溢出。 [驗收程式](../../tests/e2e/web-browser.test.ts)
- **VERIFIED** ingest 16/16、knowledge 11/11（含 Recall@5 24/24）、Telegram 5/5、Knowledge Chromium 與 MCP 1/1。
- **UNVERIFIED** Web HTTP E2E 遇到既有 OEP 實例鎖。Excel 驗收另見下方 Gate 記錄。尚未驗證完整鍵盤流程、助理設定更換後的上游上下文及雙專案隔離。

[淺色寬版](../validation/gui/workbench-light-wide.png) · [深色寬版](../validation/gui/workbench-dark-wide.png) · [淺色窄版](../validation/gui/workbench-light-narrow.png) · [深色窄版](../validation/gui/workbench-dark-narrow.png)

## 開放列

工作台仍缺專案清單、完整鍵盤流程、工具卡、停止回合及工作／差異面板。設定仍缺頭像、模型切換及健康、回合限制、完整執行環境和語音。對話操作與專案隔離未實作。

下列為 [功能矩陣](../AEP_GUI_PARITY.md) 中含 2b 且尚未完成驗收的列。其他階段維持矩陣原有狀態。

- W Agent 名稱、自介、soul.md
- W Avatar 上傳、挑選、重設
- W Gateway Start／Restart／Refresh token／開機自啟
- W Gateway Test、provider、alias、URL、模型清單／手填、context capacity
- W SecretRef／環境變數選擇
- W 最近訊息、歷史 byte budget、工具次數、回合時限
- W 多 Agent 委派開關
- W Shared Platform portal／bridge URL、Personal Agent code、帳密登入、enroll、teams
- W Shared Platform 憑證 fingerprint／信任／下載／忘記
- W Laya SSH host／ports／account／mode／threshold／timeout／approval／auto／check
- W MCP 名稱、stdio command／args／cwd／env／secret env、remote URL／headers／token、timeout、啟停、重連、移除與狀態
- W、C Coding agents 安裝、移除、狀態；A 的 Claude Code／Codex／Copilot 開關與登入
- W、A Agent mode 預設根目錄、會話工作與唯讀資料夾
- W、A Email folders、days、舊 exclusions、會話 mail grant
- W Agent profile／Capability management
- W、V Web 麥克風及 Telegram 語音啟用／轉錄設定
- W、B BI query toolbox 開關、Atlas URL
- W 新會話、搜尋、切換、會話模型選擇
- W 私有、public 會話及 backend 驗證
- W 送訊息、排隊、進度、delegation、資料夾操作
- W 回覆指定輪次、複製、原因、評分、區段／摘要筆記
- W 附件、移除、下載、原文／表格／影像／HTML 預覽、Atlas embed
- W Slash palette、直接指令及 action card 決定
- W 能力清單技能／工作流程／知識／擴充／應用，更新、查找、狀態篩選、詳情、安裝草稿、啟停移除
- W Share Platform Library 分類／查找／狀態／同步、安裝、Portal 授權與提交審核
- W、M 記憶待確認／偏好／筆記／資料／同步進度／紀錄、立即檢查
- W、M 搜尋／標籤／關聯、勾選匯出 Markdown、聯絡人狀態與編輯
- B、G 已發卡片概覽、類別／domain／sample 篩選、詳細資料及關係、全文查詢、重建索引
- B、G Dashboard 查閱與篩選、AI 編寫 SQL、預覽、增改排序／套用
- B Shared Platform 瀏覽／訂閱／同步資料集與組織可見性
- B、G 載入示範、Atlas 連結

## Gate 記錄

- **VERIFIED** lint 138 檔、typecheck 通過、test 49/49、scan 0 命中。
- **UNVERIFIED** `test:e2e:excel` 與 `test:e2e:excel:synthetic` 都在 OpenCode 啟動階段結束，未執行工作簿案例。
