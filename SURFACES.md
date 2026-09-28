# Surfaces
Every place delegated work happens, and what can be recovered from each. This file is the authoritative list; the home page links it from the FAQ.
A surface is where the interaction happened. A provider is whose model answered. They are separate dimensions: an IDE extension is a surface, and the model behind it is a provider. One provider reaches you through several surfaces, and one surface routes to several providers.
## Supported services
Every agentic surface this project knows about, in one list: what ships today, what is planned next and how, what is still being researched, and what can never be counted. The target is every surface; this list says honestly where the release stands against it. The detailed register further down gives the recovery state and evidence for each source id.

Status:
- **Ships**: an extractor, estimator, or capture is in this release. Run it now.
- **Planned**: the evidence is known to exist and the method is decided; it is on `ROADMAP.md`.
- **Researching**: no script-readable counter has been found yet. Evidence that one exists moves the row to Planned.
- **Not recoverable**: checked, and the surface keeps no usage anywhere a client can read.
- **Not countable**: no extractor can recover a token figure, for the structural reasons below.

Verification, for rows that ship:
- **Real data**: run against real stores or exports and matched, day by day, against an independently tested version.
- **Tool's own code**: the format is read from the tool's own recording code or schema on a real install, but that install held no usage to count yet.
- **Synthetic**: tested only against synthetic fixtures, because no install was available.

### Coding agents and CLIs

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Claude Code | Local transcripts, `npm run extract:claude-code` | Exact | Ships | Real data |
| Codex CLI and IDE | Local rollout files, `npm run extract:codex` | Exact | Ships | Real data |
| goose, and the local models it runs | Local usage ledger, `npm run extract:goose` | Exact | Ships | Real data |
| Gemini CLI | Local chat sessions, `npm run extract:gemini-cli` | Exact | Ships | Tool's own code (0.58.0) |
| Qwen Code | Local chat sessions in Gemini CLI's format, `npm run extract:gemini-cli` | Exact | Ships | Synthetic |
| GitHub Copilot CLI | Session state, increase at each session end, `npm run extract:copilot-cli` | Exact per session | Ships | Tool's own code (SDK 1.0.73) |
| OpenCode | Local session store under its data directory | Exact | Planned | |
| Amp | Local thread store | Exact | Planned | |
| Factory Droid | Local session logs | Exact | Planned | |
| Kimi CLI | Local session logs | Exact | Planned | |
| Grok Build CLI | Local session logs | Exact | Planned | |
| Crush, Aider, Warp, Kiro | No persisted per-request counter found | Unassessed | Researching | |

### Editors and editor extensions

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Cline | Extension task counters, `npm run extract:vscode-agents` | Exact | Ships | Real data (store read; its records need `--token-convention`) |
| Kilo Code | Extension task counters, `npm run extract:vscode-agents` | Exact | Ships | Real data |
| Snapdev | Extension task counters, `npm run extract:vscode-agents` | Exact | Ships | Real data |
| Roo Code | Extension task counters, `npm run extract:vscode-agents` | Exact | Ships | Synthetic |
| Those four inside VS Code Insiders, VSCodium, Cursor, and Windsurf | The same task counters, read from each editor | Exact | Ships | Synthetic |
| Cursor's own chat and agent | Local history database, `npm run extract:cursor` | Exact as Cursor reports it | Ships | Tool's own code (3.17.21) |
| Zed agent | Local thread database, dated by thread creation, `npm run extract:zed-agent` | Exact per thread | Ships | Tool's own code (1.20.2) |
| GitHub Copilot Chat in VS Code | No token counts are kept on disk | None | Not recoverable | Checked on a real install |
| Google Antigravity | Local conversations, stored as protobuf without a published schema | Unassessed | Researching | |
| Windsurf's own agent, Continue, JetBrains AI Assistant and Junie | No persisted per-request counter found | Unassessed | Researching | |

### Desktop and chat apps

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Claude desktop app, agent sessions | Local session stores, `npm run extract:claude-code` | Exact | Ships | Real data |
| claude.ai and Claude Design | Account data export, `npm run estimate:claude-chat` | Estimated, a floor | Ships | Real data |
| ChatGPT | Account data export, `npm run estimate:chatgpt` | Estimated | Ships | Real data |
| Gemini app, Grok, Perplexity, Microsoft Copilot, Meta AI, NotebookLM | Exports and session history, with no counter found | Dates only | Researching | |

### Hosted APIs and gateways

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Anthropic API | Admin Usage Report, `npm run extract:claude-api`, held for a reconciliation verdict | Exact | Ships | Real data (same responses as the tested version) |
| OpenAI API | Organization Usage API, `npm run extract:openai-api` | Exact | Ships | Real data (same responses as the tested version) |
| Perplexity API | Counters captured from each response, the Claude Code hook or `npm run perplexity:capture` | Exact | Ships | Real data (same responses as the tested version) |
| TypeSafe API | Counters captured from each response, the same hook or `npm run typesafe:capture` | Exact | Ships | Real data (same responses as the tested version) |
| OpenRouter | Account and generation usage API, covering every model routed through it | Exact | Planned | |
| xAI, Mistral, DeepSeek, Groq, and other OpenAI-compatible APIs | Usage object in each response, through one OpenAI-compatible capture | Exact | Planned | |
| Gemini API, Vertex AI, AI Studio | Usage metadata in each response; Cloud billing export | Exact where a counter exists | Planned | |
| Azure OpenAI | Usage object in each response; Azure Monitor metrics | Exact for consumption | Planned | |
| Amazon Bedrock | Usage in each response; CloudWatch metrics | Exact for consumption | Planned | |
| LiteLLM, Helicone, Langfuse | Request-level records in the gateway's own store | Exact for what was routed through them | Planned | |

### Local model runners

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Ollama | Counters relayed through `npm run ollama:capture` | Exact | Ships | Real data |
| LM Studio, llama.cpp server, vLLM, MLX server | Usage object in each OpenAI-compatible response, through the same capture as the hosted APIs | Exact | Planned | |

### Seat-metered assistants, and what nothing can count

| Surface | Evidence, and how to run it | Fidelity | Status | Verification |
|---|---|---|---|---|
| Microsoft 365 Copilot, Amazon Q, Gemini Code Assist | Seat and activity analytics, no token counts | Dates only | Researching | |
| Provider-side search and research steps; image and video generation; deleted logs | Nothing a client can read | None | Not countable | |

If you use a surface that is missing here, open an issue naming it. If you have established what it exposes, a pull request that adds the row with its evidence is better still. Rows marked Tool's own code or Synthetic move to Real data when someone runs them against a real store and reports the result.
## The four recovery states
A surface is not simply queryable or not. The record distinguishes four states, because collapsing them is how a dashboard ends up reporting absence as zero.
| State | What exists | How it lands in the dataset |
|---|---|---|
| Exact | The surface exposes an authoritative token counter an extractor can read | A row with `fidelity: exact`, carrying token and call counts |
| Estimated | No counter, but the content needed to reconstruct one survives | A row with `fidelity: estimated`, carrying tokens and no call count |
| Dates only | Activity is evidenced, but nothing supports a token figure | A `known-activity` surface bound, never a dataset row. Bounds do not imply coverage |
| Unrecoverable | Nothing survives that any client can read | Absent. Not a zero, not an estimate, not a bound |
A surface can move between states. A provider adding a usage endpoint moves it up; a retention policy deleting logs moves it down, retroactively, for the window the policy covered.
## What decides the state
Four questions, in order. The first "no" sets the ceiling.
1. Does a counter exist anywhere a client can read, in a response body, a usage endpoint, a local transcript, or an export? No counter means Exact is out.
2. Does that counter survive? A figure shown once in a UI and never persisted is not recoverable evidence.
3. Does the content survive well enough to reconstruct a count? Text an extractor can re-tokenize supports Estimated; rendered output without model identity does not.
4. Does anything at all mark that the work happened, a file timestamp, a session index, an export manifest? If yes, the surface is Dates only rather than Unrecoverable.
## Classes that are never token-countable
These are structural, not gaps waiting on an extractor. They are restated from `README.md` because they bound what any complete record can claim.
- Provider-side web search and research steps. They run inside the provider's infrastructure mid-response. The client receives a per-call marker, never a token count.
- Image and video services billed per generated asset. There is no token counter to capture, because tokens are not the billing or accounting unit.
- Consumer chat surfaces that expose no counter at any layer. Some return rendered text only, with no usage figure in any response a client can read.
- Local inference not routed through a capture. A model run directly, through a desktop app, or through a third-party client passes through no wrapper that reads its counters.
- Deleted or rotated logs. Once retention or a reinstall removes a transcript, the counters it held exist nowhere else.
## The surface register
Status column meanings, strongest first. **Shipped**: an extractor or capture is in this release. **Tested, being ported**: an extractor exists and has been run against real stores, and is being brought to the release bar. **Documented**: the dedupe convention is specified in `DATA_CONTRACT.md` and an extractor can be written against it. **Reported**: secondary research says what the surface exposes, and nobody here has confirmed it against the product. **Recognized**: the dashboard has a label for the source id and the repository asserts nothing at all. **Structural**: a class above applies and no extractor can change it.
Reported and Recognized are both open questions, differing only in whether anything has been read about the surface. A Reported row carries a date, because vendor reporting changes and a claim about it goes stale without announcing itself. Neither is a claim of queryability.
### The second axis: where the counter comes from
Recovery state says whether a figure can exist. It does not say how much to trust it. The receipt schema's `authority` field carries that separately, as `provider`, `tool`, `reconstructed`, or `estimated`, and evidence precedence runs in that order. Four sources can all be `exact` and still not be equally authoritative:
- A **provider's own response**, returning usage alongside the completion. Highest authority, and the only one that is contemporaneous with the request.
- A **cloud billing or service telemetry export**, authoritative for consumption and usually coarser than one request.
- A **gateway or observability record**, authoritative for everything that traversed it and silent about everything that did not.
- A **client-side reconstruction**, re-tokenizing content the surface never counted. Honest as an estimate, never as a provider figure.
Publishing this axis in the dashboard is item 6 of `ROADMAP.md`.
| Source id | Surface | Best achievable state | Status | Basis |
|---|---|---|---|---|
| `ollama` | Local inference relayed through the shipped capture | Exact | Shipped | `scripts/ollama-capture.mjs`; counters come from the response, one receipt per call |
| `claude_code`, `claude_cowork` | Claude Code and desktop agent sessions, local transcripts | Exact | Shipped | `DATA_CONTRACT.md` dedupe key `requestId`, latest timestamp wins |
| `perplexity_api` | Perplexity API, captured at call time | Exact | Shipped | `scripts/perplexity-capture.mjs`; counters from each response, deduped by the response's own id, so a call captured twice counts once |
| `typesafe_api` | TypeSafe API, captured at call time | Exact | Shipped | `scripts/typesafe-capture.mjs`; no request id is exposed, so receipts key on a SHA-256 of the canonical response |
| generic | Any source exposing a cumulative snapshot | Exact | Documented | `DATA_CONTRACT.md` `snapshot_key` dominance rules |
| `claude_api`, `openai_api` | Organization usage reports for hosted provider APIs | Exact | Shipped | `scripts/extract-claude-api.js` and `scripts/extract-openai-api.js`; provider authority, account-scoped. A report covers every client using the organization's keys, so it needs a reconciliation verdict against client-side sources for the same account; Anthropic has one, OpenAI does not yet |
| n/a | Gemini, Vertex, xAI APIs | Exact | Reported (2026-09-22) | Secondary research: per-request usage metadata. No source id yet |
| n/a | Azure OpenAI, Bedrock | Exact for consumption, coarser per request | Reported (2026-09-22) | Secondary research: cloud billing and service telemetry are authoritative for consumption; per-request token detail generally needs client-side or gateway instrumentation |
| n/a | Gateways and observability layers: LiteLLM, OpenRouter, Helicone, Langfuse | Exact for everything that traversed them | Reported (2026-09-22) | Secondary research: request-level records with a stable identity, covering every provider behind the layer and nothing that bypassed it. Highest-yield extractor target per `ROADMAP.md` item 5 |
| `codex` | Codex CLI and IDE | Exact | Shipped | `scripts/extract-codex.js`; cumulative token_count snapshots per rollout |
| `cline`, `roo_code`, `kilo`, `snapdev` | Cline-family VS Code agent extensions | Exact | Shipped | `scripts/extract-vscode-agents.js`; settled api_req_started counters per task, convention decided per record |
| `chatgpt`, `claude_chat`, `claude_design` | Consumer chat products with a content export | Estimated | Shipped | `scripts/estimate-chatgpt.js` and `scripts/estimate-claude-chat.js`; four characters per token over the exported content. No counter exists, and re-sent context is not modelled, so each is a floor |
| `gemini`, `grok`, `perplexity_chat` | Consumer chat products | Dates only, pending evidence of a counter | Reported (2026-09-22) | Secondary research: consumer subscriptions generally report quotas, message windows, or credits rather than authoritative token totals. That makes Dates only the working assumption and Exact the claim requiring evidence, which inverts the burden of proof for this row group. Unconfirmed per product |
| n/a | Seat-metered assistants: GitHub Copilot, Microsoft 365 Copilot, Amazon Q, Gemini Code Assist | Dates only | Reported (2026-09-22) | Secondary research: admin analytics report seats, active users, and feature usage. Underlying token counts are generally not exposed to a subscriber |
| `qwen_local`, `llama_local`, `gemma_local`, `deepseek_local`, `gpt_oss` | Local models | Exact when run through goose or relayed through a capture, otherwise Unrecoverable | Shipped for goose and Ollama | The state is decided by whether the call passes through a capture, not by the model. llama.cpp, LM Studio, MLX, and vLLM each expose per-call counters and none has a capture yet |
| n/a | Provider-side search and research steps | Unrecoverable | Structural | Per-call marker only |
| n/a | Image and video generation services | Unrecoverable | Structural | No token accounting unit |
| n/a | Deleted or rotated logs | Unrecoverable | Structural | Evidence destroyed |
### Reading this table honestly
Every Reported and Recognized row is an open question, not a promise. A Reported row rests on secondary research about a vendor, which is the weakest evidence this file admits: it is what someone published about the product, not what anyone here observed it do. The repository ships extractors for Claude Code, Codex, goose, the Cline family of VS Code agent extensions, and the Anthropic and OpenAI usage APIs, estimators for the claude.ai and ChatGPT exports, and the Perplexity, TypeSafe, and Ollama captures, today, and the other tested extractors are being ported. Adding a row's extractor requires a verified dependency closure against the store it reads and a test proving that an absent source reads as unavailable rather than as a measured zero, which is the requirement in `CONTRIBUTING.md`. Until that exists, the surface contributes nothing and the dataset says so by leaving it out.
If you verify a surface's real behaviour, open a pull request that moves its row and cites how you established it. A row promoted without evidence is the failure this project exists to prevent.
## Adding a surface
1. Establish which state the surface can reach, using the four questions above.
2. Write the extractor read-only and idempotent against the store it reads, per invariant 9 in `INTENT.md`.
3. Key its receipts so the reconciliation rules apply, per the dedupe table in `DATA_CONTRACT.md`.
4. Prove that an unreadable source is classified, not swallowed: does not exist and cannot be read are different findings, and only the first is evidence of absence.
5. Add the source id to the dashboard's label map, and move its row here with the basis that justifies it.
