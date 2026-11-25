# Local agent transcripts
Use this when you run a coding agent or editor agent on this machine and want its usage in your record. These extractors read the agent's own session store read-only and count what the tool itself recorded.
This guide needs your own source. The shipped fixtures hold receipts, not agent session stores, so there is nothing synthetic to point these extractors at.
## The usual path
`npm run refresh` runs every extractor below, imports what they find, and rebuilds your dashboard. Run an extractor on its own only to read a backup, a store copied from another machine, or to answer a question the refresh summary raised.
Literal
```bash
npm run refresh
```
## What each extractor reads
- Claude Code: `npm run extract:claude-code` reads the transcript store (`$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`) and the desktop app's session stores. Point `--root` at a backup of the transcript store to recover days the CLI has since pruned.
- Codex: `npm run extract:codex` reads `$CODEX_HOME` (or `~/.codex`), counting non-cached input plus output. To read a backup or a store copied from another machine, pass `--sessions DIR` with `--local-store` for your own store or `--tag ORIGIN` for someone else's.
- goose: `npm run extract:goose` opens goose's `sessions.db` read-only through Node's built-in SQLite, so no `sqlite3` program is needed. It maps local models to their family (`qwen_local`, `gemma_local`) and labels calls goose routed to a hosted provider as `goose_<provider>`.
- VS Code agents: `npm run extract:vscode-agents` reads Cline, Roo Code, Kilo Code, and Snapdev task stores in VS Code, VS Code Insiders, VSCodium, Cursor, and Windsurf.
- Cursor: `npm run extract:cursor` reads Cursor's chat and agent history, as Cursor reports each message's token count.
- Zed: `npm run extract:zed-agent` reads Zed's agent threads, each thread dated by the day it was created.
- Gemini CLI and Qwen Code: `npm run extract:gemini-cli` reads their chat sessions, excluding cached input from the headline.
- Copilot CLI: `npm run extract:copilot-cli` reads GitHub Copilot CLI session state, counting each session's increase at every shutdown.
Each writes one receipt file per source under `scratch/receipts/`.
## What a successful run reports
Each extractor reports every store it looks for as read, not found, or unreadable, and exits 0 when every store was read or not found. A store that is not there writes nothing. That is the correct result for a tool you do not use, not a zero.
## When it exits 3
Exit 3 means some usage is unknown, not zero. The extractor leaves the previous receipts for that source alone, and `npm run refresh` carries on with the rest and names it in the summary. The causes:
- A store exists but cannot be read.
- A malformed interior JSONL record or an incomplete final append in a Codex rollout file. The last known-good receipt set is kept, because a partial exact result would turn missing evidence into a lower count. Rerun once the tool has finished writing.
- A record that fits two counting conventions and needs a decision from you.
The decisions are:
- goose: ledger rows with cache reads need `--cache-convention`, because whether goose's input count includes them varies by provider.
- VS Code agents: records whose cache counters fit both conventions need `--token-convention legacy` or `inclusive`. It depends on the provider the extension was pointed at, and can be given per source as `SOURCE=legacy` or `SOURCE=inclusive`.
Record a decision once in `config/record.json`, as arguments per step, and `npm run refresh` passes it every time. This example sets the Snapdev convention:
Literal
```json
{ "dir": "record", "options": { "extract:vscode-agents": ["--token-convention", "snapdev=inclusive"] } }
```
For goose, the VS Code agents, Cursor, Zed, Gemini CLI, and Copilot CLI, exit 64 is a usage error in the command line and 66 means an explicit `--root` or `--db` path does not exist.
## What it cannot see
A transcript or session log removed by a retention policy or a reinstall cannot be recovered from anywhere else. Cline's store is read but not yet counted, because its records need a `--token-convention` choice. The state of every agent and editor is in [SURFACES.md, coding agents and CLIs](../SURFACES.md#coding-agents-and-clis) and [editors and editor extensions](../SURFACES.md#editors-and-editor-extensions).
