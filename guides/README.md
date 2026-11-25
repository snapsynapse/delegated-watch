# Guides
Task-level guides for running Delegated.watch on a record of your own. The [README](../README.md) is the tutorial: a worked synthetic receipt, a first trial on the shipped fixtures, and `npm run refresh`. These pages pick up where that ends, one per kind of source.
Every page here uses synthetic examples only. None of them holds anyone's real usage, receipts, account aliases, or keys.
## Bring in a source
- [Local agent transcripts](local-agent-transcripts.md): Claude Code, Codex, goose, the VS Code agent extensions, Cursor, Zed, Gemini CLI, and Copilot CLI.
- [Local and OpenAI-compatible captures](local-and-openai-compatible-captures.md): Ollama, LM Studio, llama.cpp, vLLM, MLX, and the hosted presets.
- [Organization usage reports](organization-usage-reports.md): the Anthropic and OpenAI admin reports, their reconciliation, and what an unreachable preflight means.
- [Consumer chat exports](consumer-chat-exports.md): claude.ai and ChatGPT account exports, estimated.
- [Perplexity and TypeSafe capture](perplexity-and-typesafe-capture.md): the Claude Code hook and the scripted relays.
- Any other source: write receipts to the contract in [DATA_CONTRACT.md](../DATA_CONTRACT.md) and run `npm run import`. Writing an extractor for a new service is covered in [CONTRIBUTING.md](../CONTRIBUTING.md).
## Use the record
- [Reading your record](reading-your-record.md): what the dashboard answers and the decision each answer informs, shown on the synthetic dataset.
- [Commands](commands.md): every `npm run` script, one line each.
## Where the limits are
[SURFACES.md](../SURFACES.md) is the one list of every surface: what ships, how each was verified, what is planned, and what cannot be counted. Each guide links the rows that apply to it.
