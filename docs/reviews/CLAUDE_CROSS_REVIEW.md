# Claude Code — Stage 2 交叉審查（2026-11-21）

> **範圍聲明（誠實揭露）**：因 Claude 的 token 即將用盡，我只讀了 `CODEX_STAGE1_REVIEW.md` 的 §A（查證紀錄，L7–41）、§G（owner 問題）、§H（五項立場）。
> §B–§F（架構、風險、缺口、建議、驗收）**我沒有讀**，所以下列「同意」僅限我讀過的部分，Stage 3 不得把本文件當成 Claude 已審閱 Codex 全文。

## 1. 我撤回／修正的結論
| 我 Stage 1 的說法 | 修正 | 依據 |
|---|---|---|
| 「OpenCode 無原生排程（文件未見）」 | **撤回**。v2.3.2 有 experimental Automation（單次/間隔/cron、SQLite lease、漏跑處理），`/api/experimental/automation`；但無 Run Now endpoint、API 明示可能破壞相容、Windows 睡眠/重啟行為未實測 | Codex §A(e)，讀原始碼；我只查了文件頁面，是弱負面證據 |
| 「`opencode serve` 於 v1/v2 差異、SSE、auth 未驗證」 | Codex 已補：`GET /api/event`（斷線**不重播**、慢 consumer overflow）、預設 127.0.0.1、需 password（Basic，固定 username `opencode`）、預設 CORS 含 localhost 各 port | Codex §A(b)(h) |
| 「BI_VAULT 文件寫『Nothing implemented』= 文件落後」 | **部分修正**：檔首保留設計狀態，但 §11 逐項記錄 V2–V5 已完成；AEP 另有 `aep_bi/inbox/*`（collect/remind 排程、去重）。「文件不可信」過強，應改為「檔首狀態與內文不一致，須逐功能以程式/測試驗證」 | Codex §A 表 |
| 「Telegram cursor 設計可借用」 | **加限定**：Codex 讀碼指出 hook 例外被捕捉後 cursor 仍可前推，記憶體 `_seen` 去重 → crash/失敗可能重複或遺失。借用設計概念，但 OEP 須採「先持久化工作項、處理成功才前推」的 at-least-once + 冪等語意 | Codex §A（L19，推論，未端到端重現） |
| 「版本線決策 V1 vs V2 待 spike」 | **與 Codex 收斂**：鎖 **v2.3.2**（正式 release、有 Windows binary）。新套件名為 `@opencode/cli`、`@opencode/client`、`@opencode/sdk`；舊 `opencode-ai` npm 仍指 1.19.6，是陷阱。鎖 binary + client + OpenAPI spec hash | Codex §A + 我的 release 查證 |

## 2. 對 Codex 五項立場的回應
1. **鎖 v2.3.2 + v2 client** — **同意（共識）**。補充：OpenAPI `info.version` 只是 `0.0.1`，不能當相容性依據，須以 spec hash + 契約測試；列入升級政策。
2. **BI ingest 時點與工作帳本由 OEP 持有** — **同意（共識，理由更新）**。我原本理由是「OpenCode 沒排程」，已撤回；新理由：OpenCode Automation 為 experimental、無 Run Now、且 BI 需要自己的來源/去重/待審/通知/恢復交易語意。
   建議：OEP 持有 BI job ledger 與冪等 key（沿用 AEP「commit key = run id」概念）；OpenCode Automation 僅可作為「定時送 prompt」的可選能力，不承載 BI 狀態。
3. **明確的知識問答在呼叫 OpenCode 前先 retrieval** — **部分同意，仍有分歧，須入決策記錄**。
   - Codex：OEP 入口先檢索 → 生成 → 逐 claim reference 驗證 → 否則拒答。優點：可重現的拒答條件，不依賴模型自選 tool。缺點：多一條明確入口，agent 自行判斷的知識需求不被涵蓋。
   - Claude（原案）：`knowledge_ask` MCP tool + agent permission 限縮。優點：agent 在任何對話中都能用同一服務；缺點：模型仍可能不呼叫 tool，**無法保證**。
   - **我的建議（混合）**：同一個 knowledge service，兩個入口——(a) OEP 明確知識查詢入口＝**有強制保證**（Codex 方案）；(b) 暴露為 MCP tool 供 agent 自發使用＝**盡力而為**，且 tool 回傳必須經同一 verifier。驗收文件須明寫「強制保證只適用於 (a)」。是否要求 Telegram Main Bot / 直接用 OpenCode 的使用者也被強制，屬 owner 決策（Codex §G.3）。
4. **首版新 OEP Web + 獨立領域介面** — **同意（共識）**。我另提「是否直接用 OpenCode 內建 web client 做聊天」；Codex 結論是新 Web。我接受，前提：Stage 3 需說明為何不用內建 client（BI 審核頁、上傳路徑安全、不暴露 OpenCode 密碼給瀏覽器）。
5. **FTS5 + 中文詞法 + 合成 gold set 先於 vector store** — **同意**。我之前未涉及；理由（料號/規格精確匹配、先量測再決定 embedding egress）合理，且與「公司資料外送」風險一致。

## 3. 尚未對齊／需 Stage 3 明確裁決
- **domain service 的實作語言**（Claude 傾向 Python；Codex 立場未在 §H，我未讀 §E）。
- **授權**：兩份報告一致指出 AEP 無 LICENSE。Codex 另提到 snapshot 追蹤了 `.env` 檔名；我只列了檔名：它是 **目錄** `.env/`，內含 `README.md` 與 `example.yaml`，看起來是範例而非密鑰（我未讀內容）。若 owner 想確認，可自行檢查；**OEP 不得修改 AEP**。
- 排程中 Windows 睡眠/登出/補跑策略（Codex §G.5）。
- Excel：OpenCode 不直接讀 xlsx，需 OEP 轉換/受控工具（兩份一致）。

## 4. 對 Stage 3 的要求
1. 衝突時以「有原始碼/一手來源證據」者為準；Claude 僅讀文件的結論（如排程）讓位。
2. v2 的每個 Phase 需可測驗收；Claude 報告 §F 與 Codex §F 取交集並合併較嚴格者。
3. 未達共識項（上列 §2.3、§3 第一點）以「方案 A/B、優缺點、建議」格式寫入 `REVIEW_COMPARISON.md`，並放入 owner 待決清單。
