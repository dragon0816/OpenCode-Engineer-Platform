# OpenCode Engineer Platform (OEP)

OEP is a new, local-first, single-user engineering agent platform built around OpenCode.

## Windows 工作台

在已準備的 Windows 11 x64 電腦上雙擊 `scripts/windows/Start-OEP.vbs`。OEP 會啟動固定版 OpenCode，並在預設瀏覽器打開工作台。初次安裝、附件格式與驗收命令見操作文件。 [Windows 工作台操作](docs/validation/p2-windows-web.md)

## Planning documents

- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [AEP Feature Gap Analysis](docs/AEP_FEATURE_GAP_ANALYSIS.md)
- [T3 Code Review Brief](docs/T3_CODE_REVIEW_BRIEF.md)

## Principles

- The existing AEP repository is reference-only and must not be modified.
- Use OpenCode as the agent runtime; do not build a second harness.
- Integrate BI Knowledge, LLM Wiki, Telegram and a browser-based interface.
- Review architecture with Codex and Claude Code before application implementation.
- This repository is public: do not commit company secrets, private data, credentials or proprietary source.
