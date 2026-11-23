# OEP 交接

更新日期 2026-11-22 夜（Asia/Taipei）。先前版本見 git 歷史（`git log -p docs/HANDOFF.md`）。

## 角色與工作方式

- 技術負責人（Claude Code）審查、自行重跑所有檢查、以 `npm run merge-check -- --merge <sha>` 在本機合併；推送只在擁有者指示時做。
- 開發者為 Codex（T3 `delegate_task`，worktree 隔離，`gpt-6.2-sol`，reasoningEffort high）。每個切片的簡報都要附環境注意事項（下方）。
- 擁有者不是工程師，回覆用繁體中文白話。擁有者已授權：測試時可自行停止並重開已安裝的 OEP（升級、刪檔、改真實資料仍需同意）。
- AEP 唯讀參考；OEP 公開 repo，不放公司資料、公司內部 Skill 名稱或機密。

## 已完成（main）

- GUI 以 AEP 版型重做（三區）、收尾、中英文切換、3A 模型清單與「儲存並套用」、升級與測試強化。
- Phase 3B 多助理：切片 1（助理台帳與遷移）、2a（scope、權限建構器、一次性工具票券、全域模型席位）、2b（受控檔案、Excel 走 broker、知識範圍、遠端 MCP broker、本機 MCP 暫停）、3/3b（通用通道、Telegram 多 bot、BI 服務與歸屬、channels 設定 API）。
- 健康檢查遇上游 5xx 重試一次（公司 gateway 冷啟動第一個請求常回 500）。
- 擁有者安裝版：0.3.0（含模型設定 UX）。擁有者已同意：切片 4 通過完整驗證並合併後，升級其安裝版（版本號 0.4.0），升級前先用資料複本試跑遷移。
- GitHub `origin/main` 停在 `6c280d4`，之後的提交都未推送。

## 2026-11-23 早上狀態

- 3B／3B2 全部切片（1、2a、2b、3、3b、3c、4、5、6）已合併至 main（`8b7976c`），每次合併前完整 21 項檢查皆通過。
- 擁有者安裝版已升級至 0.4.0（含至切片 4；切片 5、6 的交辦功能尚未裝到擁有者電腦，升級需擁有者同意）。
- 切片 6 未完：Web 直接對話中的 BI `/status`、補件指令（Telegram 版已完成）。
- 下一步：3I 外部 coding 幫手設計（進行中），然後 3E 能力（Skill、Workflow）。

## 進行中（2026-11-22 夜，已完成）

- 切片 3c：持久派送器 `agent_work_items`（Codex，分支 `phase-3b/slice-3c-dispatcher`）。
- 切片 4：助理 API 與 GUI（左欄、精靈、助理詳情、bot 對應表、審核來源標籤；Codex，分支 `phase-3b/slice-4-agent-gui`）。
- 兩者並行，合併時可能在 `apps/adapter/src/main.ts`、`http/chat.ts` 衝突。

## 接下來的順序

1. 切片 5（交辦工具、台帳、預算：每則訊息 3 件、每件 5 分鐘，可調）→ 切片 6（結果卡、通知、右側紀錄、BI 兩條驗收路徑）。
2. 3I 外部 coding 幫手（Claude Code、Codex；只送公開資料，機密標記阻擋）。擁有者尚未確認「LLM Gateway 導入」是否包含 3I；目前照包含處理。
3. 3E 能力：Skill 庫、Workflow 格式與執行引擎、受控 Skill 執行器、SOP→Workflow（R19）、產生 Skill（R20）、主助理預設 20 個 Skill（需求 10.3／10.5），每助理自選 Skill（10.6）。公司 Skill 檔需擁有者從 Share Platform 匯出。
4. 之後：3C 觸發、3D 記憶與名片庫（寫入前需審核）、3F Share Platform、3G Plugin、3H 自我成長、3J WhatsApp。

## 驗證流程（每次合併前）

`/tmp/oep-gates.sh <worktree> <gates...>` 會把 venv 放在 PATH 前面、設定 `OEP_PYTHON`，每個指令用新的 `OEP_DATA_DIR`，每次執行的紀錄存到 `/tmp/gate-<name>-*.log`。完整清單：lint、typecheck、test、test:e2e:browser ×3、test:e2e:knowledge、test:ingest、test:telegram、test:e2e:mcp、test:compliance、test:contract:native:isolation、test:e2e:web、build:release、test:install、test:upgrade、test:backup、test:release:determinism、test:e2e:excel、scan。

- install、upgrade、backup、web、excel 會被執行中的 OEP **或任何 OpenCode 程序**擋下；並行的 Codex 測試也會觸發。
- 遷移相關切片合併前，先用擁有者資料的**暫存複本**試跑 `migrate-data.ts` + `reconcile-upgrade`，跑完刪掉複本。
- test:e2e:excel 用真 gateway；偶發上游 500 屬外部因素，重跑。

## 簡報必附的環境注意事項

不碰 `%LOCALAPPDATA%\Programs\OEP`、`%LOCALAPPDATA%\OEP`；不用真 Telegram token；新 worktree 先 `npm ci`，再從主 checkout 複製 `.phase0/assets` 與 `.phase0/source`，然後執行 `node scripts/phase0/install-hooks.mjs`；venv 放 PATH 前面並設定 `OEP_PYTHON`；每個測試指令用新的 `OEP_DATA_DIR`；瀏覽器重新整理用 `window.__beforeReload` 標記模式；不得刪除或放寬斷言，除非在報告中寫明理由；不印密鑰、gateway URL 或 key。

## 已知問題

- test:e2e:mcp 偶發失敗（約 1/13），根因尚未完全排除。
- `%LOCALAPPDATA%` 中約 4 GB 舊檔（升級安全複本、舊版本資料夾、升級備份），擁有者尚未同意清理。
- 擁有者的其他待辦：BI bot token、BotFather `/setjoingroups`、撤銷舊 GitHub token、授權確認、clean-VM runbook。

## 主要文件

`docs/PHASE3_REQUIREMENTS.md`（需求與擁有者決議，第 7–10 節）、`docs/design/PHASE3B_MULTI_AGENT_DESIGN.md`（核准設計，第 11、12 節為決議與契約關卡結論）、`docs/DECISIONS.md`、`docs/TASKS.md`、`docs/reviews/PHASE3B_SLICE*_REPORT.md`。

## 2026-11-23 擁有者試用階段

- 擁有者安裝版：0.6.0（含拖放貼上附件、助理管理 UX 改善）。
- 擁有者指示：**暫停升級**，等擁有者測到一個階段、明確說可以時才升級。修正照常開發、驗證、合併到 main。
- 試用回饋記錄在 `docs/PHASE3_REQUIREMENTS.md` 第 11 節；進行中：`ux/owner-test-round-2`（通道以助理為主、筆記刪除、文字類附件、清單內粗體）。
- 2026-11-23：擁有者表示設定部分已測完一輪，**同意在進行中的修正完成後升級**（owner-test-round-2、dictation-microphone；model-sources 若尚未完成則下一次升級再含）。升級前照例用資料複本試跑遷移。
