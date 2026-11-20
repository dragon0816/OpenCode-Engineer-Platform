# Phase 0　來源、版本、授權與處置

清冊以 Phase 0 checkout、合成素材與直接鎖定的執行候選為界。上游原生包或映像的內部組件依上游通知追溯，此輪不再打包它們。

| 候選項 | 版本或識別 | 來源 | 授權與處置 |
|---|---|---|---|
| OEP 工作、文件、測試 probes | `phase-0/spikes`，起點 `60bbe88` | 本 repo | 自有新增程式 MIT，提交原始碼及報告 |
| PNG、PDF、XLSX 與 CSV | 固定 SHA-256，S3 表列 | 自製 `attachment_fixtures.py` 及轉換 probe | MIT，提交合成輸入。CSV 本機重建，無真資料 |
| 知識題與 passage | `gold.v1` 及固定 SHA-256 | 本 repo 原創繁中／英文合成文字 | MIT，提交資料與人工固定標註 |
| AEP | `c9961b2d0d66eef3892375213ce305883ebde960` | [唯讀公開快照](https://github.com/dragon0816/agentic-engineering-platform/tree/c9961b2d0d66eef3892375213ce305883ebde960) | 歷史審查未見根目錄通用 LICENSE。僅引用公開路徑及設計概念，排除 code、資料、素材及 benchmark |
| OpenCode Windows／Linux binary、CLI、SDK、OpenAPI | `v2.3.2`／`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` | [官方 release 與 repo](https://github.com/anomalyco/opencode/releases/tag/v2.3.2) | [MIT](https://github.com/anomalyco/opencode/blob/v2.3.2/LICENSE)，依 SHA-256 外部下載。不提交 binary、OpenAPI 全檔或 SDK。若未來重分發保留上游 notices |
| `@opencode/client`、`@opencode/protocol`、`@opencode/schema` | `2.3.2` | [npm lockfile](../../package-lock.json) | MIT，從 npm 依 integrity 安裝，不 vendor |
| `@standard-schema/spec` | `1.1.0` | [npm lockfile](../../package-lock.json) | MIT，間接依賴，從 npm 安裝 |
| `effect` | `4.1.0` | [npm lockfile](../../package-lock.json) | MIT，由 client 選用的 peer 鏈引入，不 vendor |
| `@types/node` | `24.12.4` | [npm lockfile](../../package-lock.json) | MIT，開發用型別 |
| `undici-types` | `7.16.0` | [npm lockfile](../../package-lock.json) | MIT，開發用間接型別 |
| `typescript` | `6.0.3` | [npm lockfile](../../package-lock.json) | Apache-2.0，開發用編譯器，不隨本輪程式包分發 |
| `openpyxl` | `3.1.5` | [PyPI](https://pypi.org/project/openpyxl/3.1.5/) | MIT，XLSX probe 執行依賴，外部安裝 |
| `et-xmlfile` | `2.0.0` | [PyPI](https://pypi.org/project/et-xmlfile/2.0.0/) | MIT，openpyxl 間接依賴，外部安裝 |
| `pypdf` | `6.1.1` | [PyPI](https://pypi.org/project/pypdf/6.1.1/) | BSD-3-Clause，PDF probe 執行依賴，外部安裝 |
| Node.js／npm | `24.14.1`／`11.11.0` | [Node.js 官方發行](https://nodejs.org/dist/v24.14.1/) | Node MIT 與內含第三方 notices，npm CLI Artistic-2.0；既有環境，本輪不附帶 |
| CPython | `3.12.7` | [Python 官方發行](https://www.python.org/downloads/release/python-3127/) | PSF 與內含組件授權；既有環境，本輪不附帶 |
| Podman 與官方 Node 映像 | `5.4.0`，映像 digest 見 `config/opencode.pin.json` | [Podman](https://github.com/containers/podman) · [Node 官方映像](https://hub.docker.com/_/node) | Podman Apache-2.0，Node/Debian 映像沿用其各組件授權；僅驗證環境，排除重新分發 |
| Windows／PowerShell | Windows 11 x64 25H2 build 26200、PowerShell 7 | [Windows](https://www.microsoft.com/windows/) · [PowerShell](https://github.com/PowerShell/PowerShell) | Windows 由主機授權，PowerShell MIT 與第三方 notices。既有環境，本輪不附帶 |
| GitHub Actions | `actions/checkout@v6`、`actions/setup-node@v6` | [checkout](https://github.com/actions/checkout/tree/v6) · [setup-node](https://github.com/actions/setup-node/tree/v6) | MIT，CI 遠端使用，不複製到 repo |
| 公司 Gateway 與測試憑證 | Owner 授權的 Phase 0 測試介面 | 私有，Key scope 與保留策略待確認 | 沒有分發授權，排除位址、憑證、原始回應及服務設定 |

驗證用安裝目錄與來源下載皆由 `.gitignore` 排除。CLI/SDK/npm 名稱採 v2 命名，沒有依賴舊 `opencode-ai` 套件。S1 正式 lock 唯一 client 入口為 `@opencode/client`。 [S1 鎖定證據](p0-s1-version.md)
