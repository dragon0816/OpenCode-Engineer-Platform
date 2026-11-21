# Phase 2b Slice 4B 進度

- **VERIFIED** Windows stdio 定義可新增、更新、讀回及移除。會驗證命令陣列、本機執行檔路徑、現有工作資料夾、環境變數名稱、專案及逾時，並限制 20 筆。SQLite 與 WAL 的合成測試只使用憑證參照名稱。 [測試](../../tests/contract/custom-mcp.test.ts)
- **VERIFIED** 備份與回復保留合成定義，清單列出憑證名稱，合成標記未出現在備份資料庫或清單。 [測試](../../tests/e2e/backup-restore.test.ts)
- **VERIFIED** lint、typecheck、test 55/55、scan 零命中、compliance 2/2、backup 1/1。核心測試也涵蓋合成檢索 Recall@5 24/24。
- **UNVERIFIED** 仍需實作設定 API、憑證值儲存與注入、新會話的專案隔離、連線測試、程序清理、設定頁、遠端驗證及完整的憑證外洩掃描。未產出本切片截圖，也未執行其他端對端套件或完整模型 benchmark。
- 功能矩陣的通用 MCP、Email 替代操作及能力管理列仍開放。Email 維持 Replace，範圍說明與專案允許清單由 MCP 設定提供。 [功能矩陣](../AEP_GUI_PARITY.md)
