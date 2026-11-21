# Phase 5 驗收狀態

整體驗收 **UNVERIFIED**。本輪先交付發行建置。操作步驟和本機測試證據見發行驗證紀錄。 [發行驗證](../validation/p5-release.md)

| 驗收項目 | 狀態與範圍 |
|---|---|
| 發行打包 | 建置 ZIP、列出檔案大小與 SHA-256，驗固定版 OpenCode ZIP、執行檔和 OpenAPI。Node.js 24、Python 3.12 和 PowerShell 7 為外部先決條件。 |
| 發行掃描 | ZIP 解開後逐項檢查。第一方文字採專案規則，官方套件與規格採固定內容驗證及憑證規則，固定執行檔比對雜湊與本機憑證位元組。 |
| 清單、授權、簽章 | ZIP 有 SHA256SUMS。CycloneDX SBOM、NOTICE、完整授權審查及可選的分離簽章欄位 **UNVERIFIED**。ZIP 未簽署。 |
| 安裝與解除安裝 | **UNVERIFIED**。安裝紀錄、捷徑、登入自啟、降版保護及同一安裝範圍的程序停止尚未交付。 |
| 備份與回復 | **UNVERIFIED**。一致性快照、憑證重綁、還原前保護與資料比對未完成。 |
| 升級與回退 | **UNVERIFIED**。版本切換、資料遷移、待確認工作對帳、兩版本演練與中斷復原未完成。 |
| 六類安裝版流程 | **UNVERIFIED**。SOP→Excel、PNG/PDF 預覽、Telegram→BI→人工審核、Ask 引用、schema 發布與回退、備份回復均待從安裝版驗證。 |
| RPO、RTO | **UNVERIFIED**。尚無大型合成資料集的備份及回復時間。 |
| Windows 11 x64 乾淨 VM | **UNVERIFIED**。本機無可用 VM 或 Windows Sandbox。 |
| Windows CI 與獨立審查 | **UNVERIFIED**。Windows 發行 CI 待交付，Technical Lead 審查待進行。 |

## 沿用的限制

- Relay 先緩衝回應再遮蔽敏感資料，逐 token 顯示未驗。
- MCP、郵件、能力管理、記憶和聯絡人的 GUI 仍有缺項。
- 唯讀資料夾直接瀏覽與來源位元組保留政策仍待處理。
- Phase 3b R6 的提案值與引文一致性仍待處理。
- 真實睡眠／喚醒與登出／登入為 **O-3b – WAIVED by owner – not tested**。排程與復原行為只具合成條件下的既有證據。
- 真實 BI bot 待設定 token 後補測。公開回歸使用合成資料。Gateway 的 LAN 明文 HTTP 仍是已知限制。
