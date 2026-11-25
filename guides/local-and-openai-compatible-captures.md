# Local and OpenAI-compatible captures
Use this when you call a model from a script: a local runner such as Ollama or LM Studio, or a hosted API that speaks the OpenAI chat completions shape. No log of those calls survives on its own, so the count has to be captured as each call happens.
A capture is a relay. It passes the request and the response through unchanged and keeps only the model identity and the counters from the response. It never writes the prompt, the messages, or the generated text.
This guide needs your own source: a running local runner, or an account with a hosted provider. The shipped fixtures do not include one.
## Ollama
Relay each call to a local Ollama endpoint through the capture. `--endpoint` is `generate` or `chat`. The request body is read from standard input, here a file named `request.json` in the current directory.
Literal
```bash
npm run ollama:capture -- --endpoint generate < request.json
```
Receipts are written to `scratch/receipts/ollama-capture.jsonl`, and the next `npm run refresh` or `npm run import` picks them up.
## OpenAI-compatible runners and hosted APIs
Presets cover LM Studio, llama.cpp, vLLM, and MLX locally, and xAI, Mistral, DeepSeek, Groq, OpenRouter, and Together hosted. Each hosted preset reads its key from its own environment variable, such as `XAI_API_KEY`.
Literal
```bash
npm run openai-compatible:capture -- --provider lmstudio < request.json
```
For any other endpoint, pass `--base-url` with `--source`, and `--key-env` naming the variable that holds its key. `--base-url` also overrides a preset's URL, for a runner on another port.
Streaming requests are refused. Usage arrives in a final chunk only when the request asks for it, and the relay never rewrites a request. Send the request without streaming.
Direct OpenAI calls are excluded from this capture and are measured through the organization usage report instead, as described in [Organization usage reports](organization-usage-reports.md). That report remains quarantined until its configured scope decision establishes whether it is additive, so exclusion from this capture alone is not a universal no-double-count guarantee.
## What it cannot see
A model run directly, through an app, or through a third-party client never passes through the relay, so the call leaves no trace here. The state of each runner and hosted API is in [SURFACES.md, local model runners](../SURFACES.md#local-model-runners) and [hosted APIs and gateways](../SURFACES.md#hosted-apis-and-gateways).
