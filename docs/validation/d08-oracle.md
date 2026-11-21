# D08 合成 SOP 與逐格 smoke oracle

**APPROVED by owner (minimal smoke oracle)**。Owner 在 2026-11-21 回覆「O-4 OK」，核定 Markdown SOP 與 oracle。核定以 PDF 對照與雜湊測試通過為條件。此 oracle 僅驗證管線接線，不代表包含計算的真實多步驟 SOP。較完整的 Phase 1 oracle 可另案選擇，目前無此交付。

- [合成 SOP 文字](../../tests/fixtures/d08/sop.md) 與 [合成 SOP PDF](../../tests/fixtures/d08/sop.pdf) 以中、英文記錄相同資料和操作。
- [預期 XLSX](../../tests/fixtures/d08/expected.xlsx) 應依序包含 `Readings`、`Run`，共核對 13 格。 [機器可讀逐格 oracle](../../tests/fixtures/d08/oracle.json)
- 所有文字與布林值精確相等，數值的絕對容差為 0。`Readings` 電壓欄為小數，單位伏特，`Run` 計數欄為整數。驗收拒絕額外工作表、欄列或公式。

| 核定檔案 | SHA-256 |
|---|---|
| `oracle.json` | `28fa2ba20946adb8f49735017083eac9322f891d5cad743907afb1fdcf46b825` |
| `expected.xlsx` | `d4816db2ceaf29c237b9a622805b007fb86ac90973141769ec0d3694b7d0b914` |

用鎖定的 Python wheels 執行 `python scripts/phase0/d08_oracle_test.py -v`。測試抽取 PDF 文字，和 Markdown、逐格 JSON、XLSX 型別與值對照，並在核定雜湊漂移時失敗。更改核定值或規則需先取得新的 owner 核准。 [可填寫範本](d08-oracle.template.md)
