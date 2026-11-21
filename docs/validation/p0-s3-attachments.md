# S3　附件與有界 XLSX 轉換

本機 Windows 11 x64，Node 24.14.1，Python 3.12.7。僅測 `tests/fixtures/attachments/` 內自製合成檔。外部 model 路徑使用 S2 的同一批資料及 marker。

```powershell
python -m pip install --index-url https://pypi.org/simple --target .phase0/python -r scripts/phase0/requirements.txt
$env:PYTHONPATH = (Resolve-Path .phase0/python).Path
python scripts/phase0/attachment_fixtures.py
python scripts/phase0/attachment_probe.py
npm test
```

| 檔案 | SHA-256 | 結果 |
|---|---|---|
| `marker.png` | `8397795d271a42d4476c826c69f98cd4a63b7ee91a6d124b8b05be6dd6e8b69f` | S2 兩個 alias 各回 `ORBIT-7349`，本機檢查 PNG 簽章 |
| `marker.pdf` | `a4add5602420ebf584e4f4a601d4cbe932c2060bdb0fb0fce5686a6241f641ba` | S2 兩個 alias 與本機解析各回 `PRINT-2746` |
| `scanned.pdf` | `2086b97f030f69dadcfe8e38678f8a1100d899671741e3366408c57f96a03155` | image-only PDF 回 `OCR_REQUIRED` |
| `table.xlsx` | `6919616d6ed1da164a1e7da9f74e07e2810f68016e363964a5ab66848535cc4c` | `量測` 與 `Notes` 兩個 sheet，15 格逐格核對來源行／格、型別及值 |
| `.phase0/attachments/table.csv` | `26364dac52fafe7eb797453c92354b66bff6fbbb695667fffc4c9bdbc412a971` | 忽略的重建產物，CSV 的 `sheet,row,cell,json_value` 可還原文字、數字、布林及含逗號 cell |

入口測試拒絕外部 `file:`、`data:`、HTTP/HTTPS URI、超過 20 MiB、非允許 MIME、Windows 絕對與 UNC、越根、保留名稱、ADS 和 junction。測試在 NTFS 中文／空格目錄實際建立一般檔與 junction。20 MiB 邊界可接受。經受控合成檔建立的 data URI 只用於 S2 OpenCode API probe。

XLSX 先驗 ZIP entry 數、解壓上限、XML 宣告和外部連結／macro，再使用 openpyxl read-only iterator，驗 sheet、列、欄、cell 長度、型別、公式／錯誤值。此 probe 僅處理合成檔。正式不可信檔案處理仍需有界程序、原子開啟與 reparse 防護。PNG/PDF Gateway 實測跑的是固定版 Linux binary。 [S2 觀察](p0-s2-gateway.md)
## 第 2 輪　安全解析及逐格負例

使用 `python -m pip install --only-binary=:all: --require-hashes --target .phase0/python-round2 -r scripts/phase0/requirements.txt` 重建 wheel 依賴，將 `PYTHONPATH` 指向該目錄再跑 `python scripts/phase0/attachment_probe_test.py -v` 與 `python scripts/phase0/attachment_probe.py`。上游公告將 PDF 頁樹問題修補於 `pypdf 6.21.4`，依賴鎖到該版及 wheel hash。PDF 子程序在讀取前套用 256 MiB、2 秒 CPU，外層 timeout 5 秒。 [上游安全公告](https://github.com/advisories/GHSA-cggf-277g-3q54)

OOXML 依 relationships 與 Content Types 驗證所有可達部件，禁止 DTD、entities、外部 relationship 與孤立 ZIP 部件，先驗列／欄座標再進 openpyxl。Windows 從受控 staging 用同一 native handle 驗 reparse、最終路徑、link count 及長度後讀取。5 個 Python 測試通過，涵蓋超頁、非標準副檔名內 DTD、外部 relationship、過寬列、額外空 sheet、hardlink 與路徑逸出。正例仍為 `量測`／`Notes` 兩張、15 格及相同 CSV hash。
