# Phase 0 Gate — Claude Code review (2026-11-21)

> Reviewer: Claude Code (low-token, **scoped** review). Independent of the developer (Codex).

## 結論
**Gate 維持「未通過」**（同意 Codex 的判定）。目前沒有發現 Critical；有 3 項 Important 需 Codex 修、4 項需 owner/基礎設施。

## 我實際做了什麼（範圍）
- 重跑（worktree, `ace02ec`）：`npm run lint`（23 檔 exit 0）、`typecheck`（exit 0）、`npm test`（4 pass / 0 fail / 0 skip）、`npm run scan`（55 檔 hits 0）。**與報告一致。**
- 以使用者層級的實際金鑰與 gateway 主機名，掃描 **所有 commit 歷史**：命中 0；掃描被忽略的 `.phase0/`（563 檔、約 732 MB）：未發現金鑰。
- 讀碼：`run-container.ps1`、`secret-scan.mjs`、`probe-http.ts`，以及 `model-probe.ts` 的 redaction 路徑（grep 層級）。
- **未審**（請勿視為已審）：`opencode-probe.ts`（427 行）、`windows-job.cs/.ps1`、`attachment_probe.py`、`attachment-probe.ts`、`opencode.pin.json` hash 與來源、各 `docs/validation/*` 的數據真實性。**未重跑**容器內的 OpenCode/Gateway 測試（需 podman 與金鑰，且會消耗 gateway 額度）。

## 正面
- 容器：`--cap-drop all`、`no-new-privileges`、`--read-only`、非 root、`--pids-limit`、專案目錄唯讀掛載；contract 模式 `--network none`。
- 金鑰經 stdin 傳入而非 env/argv/檔案；對 relay 輸出做 redaction；OpenCode 只面對本機 relay。
- probe HTTP server 只綁 `127.0.0.1`，body/事件有上限。
- Codex 如實保留首輪失敗（19/20、forced turn FAIL），沒有為過關放寬標準。

## Important（需 Codex 修）
1. **I-1 forced `tool_choice` 完整回合 FAIL**：固定 model 設定每一步都強制工具，造成重複工具與費用。需把強制限首步，並補驗完整 turn（含工具結果後的最終文字）；逾時計失敗。
2. **I-2 secret-scan 的「private host」規則要求 `https?://` 前綴**：裸 IP（例如 `172.x.x.x:4000`）不會命中；且 `known` 比對只在環境變數存在時有效（CI 上不存在）。補一條無前綴的私網 IPv4(:port) 規則與測試（合成正反樣本）。
3. **I-3 gateway 模式使用 `--network bridge`（不受限出口）**：目前 OpenCode 看不到金鑰，風險可接受，但請在 `p0-s5-security.md`/v2 明記為 Phase 0 限定，並寫出 Phase 1 的出口限制方案（僅允許連 gateway；例如 pod 網路 allowlist 或 relay-only）。

## 需 owner／基礎設施
- O-1 金鑰 scope（短期、限 alias、限額、可撤銷）與 egress/retention 證據。
- O-2 認證回應：無 key → 500、錯 key → 400 的根因（需 gateway 管理者）。
- O-3 隔離 Windows 11 x64 VM：原生 OpenCode、睡眠/喚醒、登出/再登入。
- O-4 D08 合成 SOP/PDF 與 cell oracle 的核定。

## 其他
- `.phase0/`（約 732 MB，已被 `.gitignore`）因執行政策拒絕遞迴刪除而保留；可由 owner 手動刪除，`fetch-pins.ps1` 可重建。
- 之後每次 commit 前仍需 `npm run scan`。

---
## Re-review after fix round 1 (HEAD `31f63b0`, Claude Code, scoped)
- 重跑：lint 23 檔 exit 0；typecheck exit 0；build exit 0；`npm test` **5 pass / 0 fail / 0 skip**（原 4，新增 1）；scan 56 檔 hits 0。
- 全歷史以真實金鑰與 gateway 主機比對：0 命中。tracked 檔中無裸私網 IP。
- 測試未被放寬：`phase0.test.ts` +19/-1；forced 探測反而改為更窄的範圍檢查（僅限已核准 alias、單一 forced 回合、重複 forced 呼叫會被拒絕並計數）。
- **I-1 / I-2 / I-3：接受為已修復**（I-1 為開發者證據：兩 alias 完整 forced turn 各 6.124 s / 3.961 s、各 1 次工具呼叫；我未重跑真 gateway）。
- **新發現（Important，記入 Phase 1，非 Phase 0 阻擋）**：I-1 的做法是由本機 relay 在 follow-up 步驟把 `tool_choice` 改成 `none`。這代表 **OpenCode 靜態 model 設定的 `tool_choice` 每一步都會重送，無法單靠設定做到「只強制首步」**。Phase 1 的 Knowledge Ask / 工具強制不可依賴 model 層靜態設定；需改採 OEP 端 per-request 控制（relay 或入口層），並在 v2 驗收中明列。
- 仍未審：`opencode-probe.ts` 全文、Windows Job Object 程式、附件 probe、pin hash/來源。建議另派獨立 Codex reviewer。
- **Gate 仍未通過**：O-1（key scope/egress/retention）、O-2（500/400 根因）、O-3（隔離 Windows VM）、O-4（D08 oracle）為 owner/基礎設施阻擋，非程式缺陷。
