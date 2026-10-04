# Data Contract
## File
`public/data/daily-burn.json`
## Shape
The file is a JSON array sorted by `date` ascending. Each object represents one calendar day in the timezone configured by `config/profile.json`.
```json
{
  "date": "2025-06-12",
  "timezone": "UTC",
  "sources": {
    "codex": {
      "tokens": 42000,
      "calls": 6,
      "fidelity": "exact",
      "by_origin": {
        "machine/example": 42000
      }
    },
    "claude_code": {
      "tokens": 51000,
      "calls": 9,
      "fidelity": "exact"
    },
    "gemini": {
      "tokens": 8000,
      "fidelity": "estimated"
    }
  },
  "total": 101000,
  "driver": "building:feature",
  "evidence": "feature work, reviewed"
}
```
## Fields
- `date`: configured calendar day in `YYYY-MM-DD` form.
- `timezone`: must match `config/profile.json`.
- `sources`: object keyed by lowercase snake_case source id, one entry per provider or tool that contributed tokens that day.
- `sources.*.tokens`: exact or estimated token count for that source on that day.
- `sources.*.calls`: optional call count for sources that expose a useful call or session count.
- `sources.*.fidelity`: `exact` or `estimated`. The validator accepts `sample` only under an explicit non-public allowance for synthetic fixtures; canonical validation rejects it unconditionally.
- `sources.*.coverage`: optional `incomplete` qualification when surviving counters do not establish complete source coverage. Absence means no retained coverage limitation was reported by that receipt path; it is not a universal completeness guarantee.
- `sources.*.coverage_reasons`: required sorted, unique lowercase reason codes when `coverage` is `incomplete`. These codes are scrubbed diagnostics, not content evidence.
- `sources.*.token_components`: optional versioned component evidence. Version 1 accepts optional nonnegative safe-integer `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens`, and `reasoning_tokens`. An omitted component is unavailable; an explicit `0` is measured zero.
- `sources.*.by_origin`: optional token split keyed by origin. When present, its values must sum exactly to `sources.*.tokens`.
- `total`: sum of all `sources.*.tokens`.
- `driver`: short category explaining the main usage pattern for the day, from the reviewed vocabulary below.
- `evidence`: a scrubbed provenance note, never a raw title or prompt fragment.
A source entry with `tokens: 0` is valid only when it carries positive `calls` or at least one positive measured token component. A day with no recovered measurement remains absent. An empty zero row is invalid because it cannot distinguish unknown evidence from measured zero.
## Receipt schema (v2)
Receipt JSONL is the local ingestion contract between a capture or extractor and the importer. Version 2 requires:
- `schema_version: 2`
- Daily aggregation fields: `date`, `timezone`, `source`, `tokens`, and `fidelity`
- Independent dimensions: `provider`, `surface`, `account_alias`, and either `origin` or `machine_alias`
- `interval` containing the receipt date
- `snapshot_key` identifying cumulative snapshots for one source and scope
- `authority`: one of `provider`, `tool`, `reconstructed`, or `estimated`
- Optional sorted `models`
- Optional sorted `correlation_keys`, each a one-way `sha256:` value
- Optional `coverage: "incomplete"` with required sorted `coverage_reasons` when the measured counters survive but their surrounding evidence is incomplete
- Optional `token_components` with `schema_version: 1` and one or more measured component counters
`snapshot_key` deduplicates repeated cumulative copies of the same source snapshot; it is not a request id. `correlation_keys` identify the same inference across different sources only where a source exposes a stable request identity. Raw provider request ids must never enter a receipt.
Evidence precedence, highest first, is provider, trusted tool counter, exact reconstruction, then estimate. Two receipts with the same complete correlation-key set, calendar day, provider, and account scope collapse to the higher-authority receipt. The same rule applies when the lower-authority evidence was accepted by an earlier import: the dataset and accepted-evidence ledger transition atomically, the superseded identity history remains recorded, and replaying either receipt does not make the measurement additive again. A partial overlap, a cross-day or cross-account match, or an equal-authority cross-source conflict fails the import closed.
## Token components
The headline remains non-cached input plus output under the source's documented counter semantics. Component preservation does not redefine `sources.*.tokens` and does not create a cost estimate.
For sources where reported input includes cached input:
```text
headline = max(0, input_tokens - cached_input_tokens) + output_tokens
```
`cached_input_tokens` must not exceed `input_tokens` when both are available. `reasoning_tokens` must not exceed `output_tokens` when both are available because reasoning is already included in output. `cache_write_tokens` is retained separately because some tool counters report cache creation outside ordinary input while other counters include it; consumers must follow the source's documented convention rather than add every field together.
When several additive receipts form one `(date, source)` entry, a component is persisted only if every contributing receipt supplies it. Otherwise that component is omitted as unavailable. Older receipts and ledger entries without components remain valid. Import, accepted-ledger replay, and CSV export preserve explicit zeroes.
The detail CSV exports component columns at source scope. For a source split across multiple origins, the source-scoped component values appear once on the first sorted origin row with `component_scope` set to `source`; the remaining origin rows leave component columns blank. This preserves the evidence without implying that source-level components can be divided among origins.
## Gates
The importer enforces these before any receipt reaches the dataset.
- Cutoff. A day is only imported once it has fully elapsed in the configured timezone. Receipts for the day in progress are held back and imported once that day ends; a receipt dated after the current day fails the import outright.
- No-decrease. An import that would lower, remove, or downgrade the fidelity of an already-committed exact value is refused unless it carries an explicit correction flag, a confirmation, and a written reason. A fallen number usually means the underlying evidence disappeared, not that the original count was wrong.
- Settled entries. A `(date, source)` pair can be marked settled with the exact figure it is expected to keep. The importer drops any incoming receipt for a settled pair, so re-deriving from a depleted store can never lower a good number. Deleting the settlement returns the pair to ordinary import behavior.
- Exclusions. A `(date, source)` pair can instead be removed from the record entirely, with a fingerprinted reason, distinct from settling because the entry is gone rather than frozen.
- Reconciliation quarantine. Receipts from a source that could double-count against another already-counted source, for example an organization usage API alongside a client-side transcript for the same account, are held outside the dataset until a human records a verdict on whether the two are additive or overlapping.
## Driver vocabulary
`building:{feature,content,spec,infra}`, `fixing:{bug,pipeline,data,security}`, `maintenance:{docs,sync,hygiene,deps}`, `shipping`, `writing`, `strategy`, `research`, `career`.
`mixed` means the day's activity is identified but no dominant pattern is recoverable. `unknown` means the surviving evidence does not justify a driver. `unreviewed` is a temporary workflow state for a newly imported row, not a substantive category.
## Evidence rules
- No raw prompts.
- No transcripts.
- No secrets, tokens, keys, credentials, or auth artifacts.
- No private customer data.
- No private URLs.
- `evidence` describes a work family or review signal generically. It must never reproduce a raw conversation title or any other identifying text.
## Dedupe keys
Documented conventions for extractors you write against this contract. The claude_code, codex, goose, VS Code agent, claude_api, and openai_api extractors, the claude_chat and chatgpt estimators, and the perplexity, typesafe, and ollama captures ship with this release; the rest describe how a provider-specific extractor should key its receipts so the reconciliation rules in `scripts/lib/receipt-schema.js` apply correctly.
| Source convention | Key | Rule |
|---|---|---|
| claude_code | requestId | Latest timestamp wins. A streamed turn rewrites the same request under earlier partial counts before it settles. |
| codex | cumulative token_count snapshot within one rollout | An adjacent repeated cumulative snapshot is skipped. A copied fork is excluded only when `forked_from_id` resolves to one parent and the complete inherited prefix is bounded by `forked_from_ordinal_exclusive` or a child-owned `thread_settings_applied` record. A missing response-item id assigned during fork persistence is the only normalized structural difference; two present unequal ids never match. Referenced forks remain additive for their local records. Missing, ambiguous, or unverified lineage retains surviving child evidence with durable `incomplete` coverage reasons as well as console warnings. Copied evidence with a missing parent can duplicate inherited usage and its reserialized timestamps do not establish the original usage date. Unrelated events are never deduped by equal token counts. Receipts key on account, machine, and day, so a backup of one store dedupes and distinct stores sum. |
| goose | usage_ledger row, one per call | Receipts key on origin, source, and day. Local models take their family source id; calls goose routed to a hosted provider become `goose_<provider>` and may overlap that provider's own usage API. |
| cline, roo_code, kilo, snapdev | hash of task id, request timestamp, and request index | Receipts key on account, machine, and day. Cache reads are excluded; a record whose counters fit both the legacy and inclusive conventions is refused unless `--token-convention` breaks the tie. |
| claude_api, openai_api | account and day | One account-labelled receipt per day from the provider's organization report, with provider authority. Cache reads and cached input are excluded. The report can overlap client-side sources that used the same organization's keys, so both sources remain quarantined until a reconciliation verdict is recorded. Anthropic currently has one global reconciliation mode. OpenAI identities bind each decision and display alias to one unique stable non-secret organization scope and use a full SHA-256 scope fingerprint so organizations cannot collide or be configured under multiple aliases. |
| claude_chat, claude_design, chatgpt | conversation and message id | Estimated receipts, one per account and day. Overlapping or repeated exports dedupe by message, and a hash of the claude.ai message identity is kept so a later export is recognised after the first is deleted. |
| perplexity_api | response id | The API response's own identifier. Two independent captures of the same call reconcile to one receipt instead of double counting. |
| typesafe_api | SHA-256 of the canonical response | No request id is exposed, so byte-identical responses collapse to one receipt. |
| ollama | one receipt per captured call | Each relayed request and response pair is its own receipt; nothing is pre-aggregated before capture. |
| generic receipts | snapshot_key | Dominance rules apply: a higher token-and-call snapshot replaces a lower one, a lower one is rejected, and two snapshots that disagree in opposite directions fail the import closed. |
## Known activity: surfaces you cannot count
Some surfaces evidence that work happened without supporting a token figure. A consumer chat product reporting a quota or a message window, and nothing a client can read as a count, is the common case. Writing a guess into the dataset would break the first design invariant, and leaving the surface out entirely reports its absence as though nothing happened there.
`config/known-activity.json` is the third option. It records a bound, never a row. Bounds reach the dashboard's freshness panel and never the totals, the charts, or any figure that adds up; `accounting` is what keeps the two apart, and the dashboard contract asserts the separation on every CI job.
Entries are written by hand. No capture populates this file yet, and none is required: a bound is a fact about a date range, not a measurement, so recording one takes a person who knows when they started and last used the surface.
```json
{
  "schema_version": 1,
  "date_semantics": "First and latest known evidence of activity. These bounds do not imply continuous token coverage.",
  "surfaces": [
    {
      "id": "chatgpt",
      "label": "ChatGPT",
      "provider": "openai",
      "first_known": "2025-03-04",
      "last_known": "2025-11-19",
      "accounting": "dates_only"
    }
  ]
}
```
Fields, all required:
- `id`: source id in lowercase snake_case, matching the dashboard's label map where one exists. Sharing an id with a counted source is allowed and merges the bounds.
- `label`: display name for the freshness panel.
- `provider`: one of `openai`, `anthropic`, or `other`. `npm run eval:dashboard` rejects anything else.
- `first_known` and `last_known`: `YYYY-MM-DD`, with `first_known` no later than `last_known`. Both are validated.
- `accounting`: how the surface is counted. Use `dates_only` for a surface with no readable token counter.
Three rules govern an entry. A bound is not coverage, so it never implies that the days between were observed. A bound is not additive, so it is never summed with anything. And a bound is evidence of activity, not of volume, so a surface recorded here stays absent from every token figure the record publishes. `SURFACES.md` classifies which surfaces belong here.
