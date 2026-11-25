# Perplexity and TypeSafe capture
Use this when you call the Perplexity or TypeSafe API. The usage object in each API response is the only count that will ever exist for a call, and it is gone once the response is discarded.
Perplexity publishes no usage endpoint. TypeSafe publishes none either, as of 2026-11-24: the [TypeSafe docs index](https://docs.typesafe.ai/llms.txt) lists the System One and List models endpoints and no usage, billing, or metering endpoint, and usage is returned only in each [System One response](https://docs.typesafe.ai/api/system-one.md) as `usage.input_tokens` and `usage.output_tokens`.
This guide needs your own source: calls to either API. The shipped fixtures do not include one.
## From Claude Code
Register the capture hook once per machine, then restart Claude Code. One hook covers both providers.
Literal
```bash
npm run install:perplexity-hook
```
It edits your Claude Code `settings.json` with a private backup, preserves everything else in it, and refuses a file it cannot parse. Re-running it repoints the existing entry rather than adding a second, so it is safe after moving or re-cloning this repository. Check what is registered:
Literal
```bash
npm run install:perplexity-hook -- --check
```
The hook keeps the counters and never the query or answer. It can only capture what a command printed, so a command that prints just the answer text discards the usage object first. Print the raw response, or at least its `id`, `model`, `created`, and `usage` fields.
## From a script
For scripted calls outside Claude Code, relay a request body through the capture, which returns the response unchanged. The request body is read from standard input, here a file named `request.json` in the current directory.
Literal
```bash
npm run perplexity:capture < request.json
```
Literal
```bash
npm run typesafe:capture < request.json
```
Receipts are written to `scratch/receipts/perplexity-api.jsonl` and `scratch/receipts/typesafe-api.jsonl`, and the next `npm run refresh` or `npm run import` picks them up.
## How TypeSafe receipts are keyed
A TypeSafe System One response carries no request id and no timestamp, as of 2026-11-24: its [response schema](https://docs.typesafe.ai/api/system-one.md) has only `model`, `answers`, and `usage`. So its receipts key on a SHA-256 of the canonical response, and two byte-identical responses on one day count once.
## What it cannot see
A call whose response was never printed or relayed leaves no count anywhere. Provider-side web search and research steps run inside the provider's infrastructure, and the client receives only a per-call marker for them, never a token count. The state of each hosted API is in [SURFACES.md, hosted APIs and gateways](../SURFACES.md#hosted-apis-and-gateways).
