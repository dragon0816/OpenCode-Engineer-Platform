# Phase 3a　儲存庫資料夾驗收報告

2026-11-21（Asia/Taipei）。Windows x64、Node 24.14.1。工作分支 `phase-3a/repo-reader` 從本機 `main` 的 `7e50d76` 開始，`origin/main` 維持 `a6aa863`。合成驗收與既有真 Gateway 問答門檻通過，**實際儲存庫相容性仍為 UNVERIFIED**。

## 逐項驗收

| 項目 | 狀態 | 命令與結果 |
|---|---|---|
| AEP 公開格式與獨立實作 | PASS | 在 OS 暫存目錄淺層 clone。HEAD 為 `c9961b2d0d66eef3892375213ce305883ebde960`，`git status --short` 無輸出。紀錄公開格式、推論與待驗項目。 [格式](../validation/p3a-repo-reader.md) |
| 版本選擇、錯誤與回復 | PASS | `npm run test:knowledge` 共 8/8，新增四項契約測試涵蓋 clock／author／seq、未發布新 tag、重發舊 tag、缺少 `repo.json`、未發布、無效紀錄、缺檔／零位元組、損毀 SQLite、WAL、大小／SHA-256 不符、路徑越界、來源不變及保留世代。 |
| 卡片、欄位歷史／出處、關係與證據 | PASS | 契約測試驗證版本、關係出處、來源修訂、引用位置與 FTS5。真模型合成鏡像從 CLI 匯入得到 40 卡、41 來源、1 關係、40 段證據，`active:true`、兩項完整性檢查皆通過。以 `--restore-repo` 得到 `state:restored`，契約測試另驗兩個世代可切回。 |
| 舊 BI JSON/gzip 與 Wiki manifest | PASS | 既有 `npm run test:knowledge` 契約仍通過。Wiki 儲存庫資料夾目前可做結構檢查，Wiki 的資料夾匯入未納入。 |
| CLI 檢查及敏感內容隔離 | PASS | `npm run --silent knowledge:inspect -- <合成資料夾>` 回報 `publication.state:resolved`、`tag:resolved-tag`、五個 SQLite、選中檔 `userVersion:14`／`schemaVersion:7`，兩個故障檔使 exit 1。sentinel 證明兩種命名模式皆不輸出列值或摘錄，預設也遮蔽標籤、作者及深層路徑。 |
| Web 檢查、匯入與引用 | PASS | `npm run test:e2e:knowledge` 最終 1/1。Chromium 由空庫起步，檢查並匯入合成儲存庫、顯示發布標籤及驗證引用。測試涵蓋未配對拒絕、相對路徑拒絕，以及 OpenCode MCP 的有效結果和無效引用。初次缺固定執行檔，經 `pwsh -NoProfile -NonInteractive -File scripts/phase0/fetch-pins.ps1 -WindowsOnly` 檢查雜湊並安裝。之後測試的匿名 POST 缺 Origin 先得到 403，加入同源 Origin 後驗到預期的 401。 |
| 真 Gateway Ask 與引用重現 | PASS | `npm run knowledge:benchmark -- --repository` 走相同 Ask/verifier，以匯入 SQLite 鏡像跑完兩個 alias。Recall@5 為 24/24，同語料 baseline 24/24。逐 alias 結果如下。 |
| 開發驗證與掃描 | PASS | `npm run lint` 檢查 124 檔，`npm run typecheck` 與 `npm run build` exit 0。`npm test` 46/46，1,000 段 FTS5 暖機測試 144 次、p95 16.295 ms。已執行 `node scripts/phase0/install-hooks.mjs`。原 hook 設定指向共用 Git 目錄的舊 snapshot，改回本 worktree 的 `.githooks` 後原安裝程式成功。每次提交前 `npm run scan` 與提交 hooks 均為 0 命中。 |
| SharePoint 實際資料、OneDrive 檔案隨選、乾淨 Windows 11 x64 VM | UNVERIFIED | 此台開發機只以合成資料驗證，同步未完成以空檔／缺檔模擬。實際 SQLite 表型、來源版本與外部檔的關聯待 owner 本機確認。 |

## 真 Gateway 單輪結果

兩個 alias 各跑固定 48 題。設定由 Windows User scope 的 `OEP_LITELLM_BASE_URL` 與 `OEP_LITELLM_API_KEY` 讀入程序環境。本輪每個 alias 各有 40 筆請求、皆 HTTP 200，其餘在檢索後未送模型。Ask 提供最多一次重試，本輪實際重試 0 次。稽核目錄 `.phase0/knowledge-gold-QJPmyD/` 保存逐題去敏結果、嘗試類型、HTTP 狀態與延遲。

| Alias | 可答可用 | 不可答拒答 | 引用重現 | 關鍵無支持 | 例外 |
|---|---:|---:|---:|---:|---|
| `gpt-5.4-mini` | 23/24 | 24/24 | 23/23 | 0 | A24 有正確檢索命中，模型選擇拒答。 |
| `claude-haiku-4-5-20251001` | 24/24 | 24/24 | 24/24 | 0 | N16、I01、I02 的模型引文由驗證器拒絕，使用者結果為拒答。 |

兩個 alias 的通訊錯誤皆為 0。判定沿用可答 ≥90%、不可答拒答 ≥95%、已呈現引文重現率 100%、關鍵無支持 0。 [原 Phase 3a 門檻](PHASE3A_GATE_REPORT.md)

## 提交

- `e889d65` Read published AEP BI repository snapshots
- `5d0b182` Expose repository inspection and import in the knowledge UI
- 本報告所在提交 Document repository reader validation and handoff

## Owner 本機驗證

在可讀取同步資料夾的 Windows 裝置，於本分支的 OEP worktree 執行以下命令，將範例路徑換成本機資料夾。

```powershell
npm run --silent knowledge:inspect -- "C:\example\repo-a"
```

貼回預設檢查的 JSON，即可對照發布解析、表、欄位和列數。保留 `--silent` 且省略 `--show-names`。如果結果有錯，JSON 仍可貼回，SQLite 編號可對應錯誤。自訂頂層資料夾名如含敏感名稱，可先遮蔽名稱。

若願意將快照留存在自己的 OEP 資料目錄，可選擇執行不含模型授權的本機匯入，或從知識頁執行同一操作。

```powershell
npm run --silent knowledge:migrate -- --import-repo "C:\example\repo-a"
```

回報匯入的狀態、是否為 active、完整性檢查布林值與四項計數即可。庫識別碼、tag、revision 和相對檔名可留在本機。 [檢查、匯入與回復](../validation/p3a-repo-reader.md#本機操作)
