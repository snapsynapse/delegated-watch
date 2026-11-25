# Consumer chat exports
Use this for claude.ai and ChatGPT. Consumer chat products report no token counts, but their account data exports hold the conversations, so usage can be estimated at about four characters per token. Every entry these estimators write has fidelity `estimated`.
This guide needs your own source: an account export. The shipped fixtures do not include one.
## Get the export
- claude.ai: Settings, Privacy, Export data. Unzip the export into `raw/claude-export-<date>/`, with the export's date in place of `<date>`.
- ChatGPT: Settings, Data controls, Export data. Place the export ZIP, its manifest, or `conversations.json` anywhere under `raw/`.
`raw/` is never committed.
## Estimate
Literal
```bash
npm run estimate:claude-chat; npm run estimate:chatgpt
```
A ChatGPT ZIP is read with the `unzip` program. Where that is missing, extract it and point the estimator at the extracted files. An export that cannot be read, or has an unexpected shape, leaves the previous receipts untouched and exits 3, because the usage it holds is unknown, not zero.
## What the estimate counts
The claude.ai estimate counts everything that entered or left the model, including thinking, tool calls, tool results, and attachment text, but not the context each turn re-sends, so it is a floor. Overlapping exports dedupe by message.
The record starts at `window_start` in `config/profile.json`, 2022-11-30 by default, which is ChatGPT's public launch. Set it earlier only if your history predates it.
## What it cannot see
Chat surfaces with no export, or whose export holds no conversation content, have nothing to estimate from. The state of each chat product is in [SURFACES.md, desktop and chat apps](../SURFACES.md#desktop-and-chat-apps).
