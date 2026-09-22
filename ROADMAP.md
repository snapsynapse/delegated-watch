# Roadmap
What this repository intends to build, in priority order, and what it has decided never to build. `INTENT.md` records why past choices were made; this file records what is not done yet.
Items are ordered by whether they close a gap between a claim the repository already makes and what its schema can actually keep. An integrity gap outranks a feature.
## 1. Cache and reasoning token fields in the receipt schema
Design invariant 5 says cache and reasoning token treatment is explicit and consistent across every extractor, that cache reads are excluded from headline counts, and that they are preserved in receipt provenance. Receipt schema v2 has no field to preserve them in. `sources.*.tokens` is one number, and the shipped Ollama capture sums `prompt_eval_count` and `eval_count` into it.
For Ollama that is harmless, because local inference reports neither cache nor reasoning tokens. For Anthropic and OpenAI it is not: both report cache reads separately from fresh input, and reasoning tokens separately from visible output. An extractor written against either today must either discard that breakdown or smuggle it into the total, and both choices break the invariant.
Add optional `cached_input_tokens`, `cache_write_tokens`, and `reasoning_tokens` to receipt schema v3, excluded from `tokens` and carried through to the dataset. Headline totals keep their current meaning; the breakdown becomes inspectable rather than lost. Until this lands, invariant 5 is a claim the schema cannot honour, which should be treated as a defect rather than a backlog item.
## 2. Dates-only capture for quota-reporting surfaces
Consumer chat products generally report quotas, message windows, or credits rather than token totals. `config/known-activity.json` models a surface whose activity is evidenced but not countable, and nothing populates it.
The manual half of this is already built and shipped. The config file is read by the build, merged into the dashboard's freshness panel with an `accounting` field that keeps it apart from counted sources, and asserted by three checks in `npm run eval:dashboard`. A person can record a bound by hand today and it renders correctly. What was missing was that the schema appeared in no documentation at all; it is now specified in `DATA_CONTRACT.md`.
What remains is capture: reading the bound from the surface rather than from memory. An export manifest, a session index, a file timestamp, or a conversation list each establish a first and last date without exposing a count. The gate is strict and already enforced: a bound must never be rendered as a count, must never be summed, and must never imply that the days between were observed.
Ranked here because it is the only item that adds a class of evidence the record has never carried, rather than improving figures it already has, and because the half that was expensive turns out to be done.

## 3. `route` as an independent dimension
The same provider and the same model, reached through a different platform, is metered in a different place and often with different token semantics. OpenAI direct, Azure OpenAI, Bedrock, Vertex, and OpenRouter are routes, not providers and not surfaces.
Without a route dimension the reconciliation rules cannot tell two genuine calls from one call observed twice through different meters, which is the precise failure the correlation-key machinery exists to prevent. Invariant 7 already separates provider from surface for the same reason; route is the third axis and it is missing.
Add `route` to the receipt schema, defaulting to `direct`, and include it in the dedupe scope.
## 4. `model_requested` and `model_resolved`
A router may serve a different model than the one asked for. The schema carries an optional sorted `models` array that cannot express the difference. Recording only the resolved model loses what the caller intended; recording only the requested model misattributes the tokens. Split the field.
## 5. Gateway and observability extractors
A self-operated gateway or observability layer that every programmatic call already traverses is the highest-yield extractor target available: one extractor covers every provider behind it, with request-level counts and a stable request identity for `correlation_keys`. LiteLLM, Helicone, Langfuse, and OpenRouter each expose a queryable record.
This is a source, not an architecture. Routing workloads through a gateway is sound advice for an organization doing cost allocation, and it is not what this repository is for: a gateway captures only programmatic calls, only going forward, and only the ones you remembered to route. It sees nothing of consumer chat, nothing of an IDE extension you do not control, and nothing of the past. Adopting it as the architecture would reproduce the single-slice failure named in `INTENT.md`, with the slice being "everything routed through my proxy". A gateway also is a backend, which is out of scope by construction.
## 6. Tier the surface register by counter authority
`SURFACES.md` grades surfaces by recoverability: exact, estimated, dates only, unrecoverable. That is one axis. A second is where the counter comes from, which the `authority` field already names as provider, tool, reconstructed, or estimated, and which the dashboard does not surface.
A provider API returning usage in its own response, a cloud billing export, a gateway record, and a browser-side estimate are not equally authoritative even when all four are `exact`. Publish the second axis in the register and carry it into the dashboard so a reader can see which totals rest on a provider's own counter.
## 7. Local inference beyond Ollama
Ollama is the one shipped capture. llama.cpp, LM Studio, MLX, and vLLM each expose per-call counters and none has a capture. Local inference is in scope by explicit statement in `INTENT.md`, and it is the one class of surface where an authoritative counter is always available to whoever runs the model, so a gap here is a gap by omission rather than by provider policy.
## 8. Provider-specific extractors, in priority order
Ordered by counter authority times the share of a person's delegated work that surface plausibly carries, which is not the same ordering an organization doing cost allocation would choose.
1. Anthropic API and Claude Code, where an authoritative counter and a stable request identity both exist
2. OpenAI API, including the streaming case where usage arrives only in a final chunk when explicitly requested
3. Gemini API and Vertex
4. Perplexity API
5. A gateway, if one is operated, per item 5
6. Azure OpenAI and Bedrock, where cloud billing is authoritative for consumption and coarse for per-request detail
Each needs a verified dependency closure against the store it reads and a test proving an absent source reads as unavailable rather than as a measured zero, per `CONTRIBUTING.md`.
## Decided against, permanently
Recorded here so they are not re-proposed. Each follows from a scope boundary or an invariant in `INTENT.md`.
- **Cost fields of any kind**, including a currency amount, a pricing version, or an estimated spend. Tokens are the unit. There is no conversion in the schema or the code, by construction rather than as a display flag.
- **Prompt hashes and transcript pointers.** A hash of prompt text is a correlatable fingerprint of prompt text, and a pointer is a reference to it. Both defeat the guarantee that no prompt content enters the record, in the case that matters most, which is the record being shared.
- **Raw provider request ids.** `correlation_keys` carry one-way hashes precisely so a request can be deduplicated without its identifier being retained.
- **Organization, team, and multi-user fields.** The record is person-scoped. Chargeback and seat reporting are a different product.
- **Event-level storage.** The dataset is one scrubbed row per day per source. Per-event retention is what raw logs are, and raw logs never enter the repository.
- **A gateway, proxy, or any other backend**, as architecture. See item 5.
