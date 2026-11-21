# S7　授權與 repo hygiene

Phase 0 盤點鎖定的 8 個 npm 套件、4 個 Python wheels、OpenCode 資產與 API、CI 動作、驗證環境、OEP 及 AEP 排除範圍。清冊列出每項版本、來源、授權及處置。此輪提交的程式與合成 fixtures 採 MIT，未帶入第三方二進位、工作簿或公司素材。未授權的已納入分發項目為 0。Phase 5 的 SBOM、第三方通知及完整出貨權利盤點仍依 v2。 [MIT](../../LICENSE) · [清冊](p0-provenance.md)

`.gitignore` 排除 `.phase0/`、`node_modules/`、Python 暫存、環境檔及本機 log/key 類型。`.gitattributes` 固定文本 LF 與三種 fixture 二進位型別。`npm run scan` 掃 tracked 工作樹，pre-commit 掃 Git index，CI 按 Windows 上的 Node 版本執行 scan、lint、typecheck、test、build。可用 `git -c core.hooksPath=.githooks commit …` 啟用單次 hook，亦可為自己的 checkout 設定 `core.hooksPath`。本輪在 commit 指令啟用。

掃描只輸出規則分類與命中數，覆蓋常見 token、私鑰、URL credentials、內部 host/常見私網位址及顯式 gateway assignment。有注入測試環境值時比對確切值，輸出仍只含計數。它是可重現的阻擋檢查，未知格式、任意壓縮內文與未注入的環境值需要其他證據。Phase 0 上游 CI 設定已提交，因本分支未 push，CI 遠端執行為 **UNVERIFIED**。本機結果見 [gate report](../reviews/PHASE0_GATE_REPORT.md)。

## 第 2 輪　安裝及合併前檢查

執行 `node scripts/phase0/install-hooks.mjs`，將目前 worktree 的 `core.hooksPath` 設為 `.githooks`。用 `git config --worktree --get core.hooksPath` 核對。測試曾在獨立暫存 Git repo 實際 stage 合成 canary，commit 因 hook 命中而失敗，乾淨內容可 commit，最後清除暫存 canary。掃描加入 IPv6 ULA、裸內部主機名、URL 與 JSON 跳脫、Base64 文字及常見字串相接。規則與環境變數比對各自執行。

每次合併前，從含本版 scanner 的 checkout 執行以下命令，將 `main` 和 `phase-0/spikes` 換成實際目標與來源。三個掃描均須 exit 0、命中 0。`pre-merge-commit` 另檢查合併後工作樹與 staging，fast-forward 仍執行事前掃描。

```powershell
node scripts/phase0/secret-scan.mjs --ref main
node scripts/phase0/secret-scan.mjs --ref phase-0/spikes
npm run scan
```

## 第 3 輪　合併入口與文字編碼

掃描支援 UTF-8 BOM、UTF-16 LE/BE、UTF-32 LE/BE，以及可由 NUL 字節排列辨識的無 BOM 檔案。無效 UTF-8 時以 ASCII 相容的 Windows-1252 視圖檢查。拋棄式 clone 負例用 UTF-16 真實 staged canary 驗 commit 失敗，也測含 canary 的來源 tree 拒絕合併。乾淨來源合併後驗 clone 的 `main` hooks 已啟用。真正的 `main` 未切換或修改。

## 第 4 輪　受檢合併程序

1. 獨立複核通過後，在乾淨的目標 worktree 執行 `npm run merge-check -- --merge <已審查來源 SHA>`。若目標尚無腳本，使用乾淨且已審查的來源 worktree 的腳本絕對路徑，在目標執行 `node <來源腳本絕對路徑> --merge <已審查來源 SHA>`。目標已有腳本時，省略 `--merge` 可先做唯讀預檢。
2. 入口先解析來源與目標 commit，掃描兩個提交樹、工作樹與 index。接著從固定來源 SHA 取 hooks 與 scanner 到目標 Git worktree 的私有目錄。安裝腳本用同一個 Git 設定鎖提交 `core.hooksPath` 和 `merge.ff=false`，驗證兩設定生效及目標仍一致後，才呼叫 Git 合併。既有自訂 hooks 或 Git 設定鎖會讓入口失敗，目標 ref 不動。
3. 用 `git config --worktree --get core.hooksPath` 核對目標所用的私有快照，用 `git config --worktree --get merge.ff` 確認為 `false`。已有 hooks 原始碼的 checkout 可獨立執行 `node scripts/phase0/install-hooks.mjs`，使用該工作樹的 `.githooks`。

安裝後，`pre-commit` 掃 index，`pre-merge-commit` 掃工作樹及 index。`reference-transaction` 在任一本機分支 ref 寫入前掃新提交樹，包含一般 `git merge` 和明確覆蓋設定的 `git merge --ff-only`。直接用 Git 時只有 hook 檢查，遭拒後 Git 可能留下工作樹或 index 變動。只有受檢入口會在合併前掃來源、目標、工作樹與 index。

保護範圍為啟用設定的本機 worktree 與由 Git 執行的本機分支更新。其他 worktree 須各自安裝。使用者能改寫 hook、覆寫 Git 設定或直接改 ref 檔，這些操作超出此本機保護。遠端 ref 由遠端政策管理。
