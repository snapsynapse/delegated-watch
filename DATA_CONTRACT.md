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
- `sources.*.by_origin`: optional token split keyed by origin. When present, its values must sum exactly to `sources.*.tokens`.
- `total`: sum of all `sources.*.tokens`.
- `driver`: short category explaining the main usage pattern for the day, from the reviewed vocabulary below.
- `evidence`: a scrubbed provenance note, never a raw title or prompt fragment.
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
`snapshot_key` deduplicates repeated cumulative copies of the same source snapshot; it is not a request id. `correlation_keys` identify the same inference across different sources only where a source exposes a stable request identity. Raw provider request ids must never enter a receipt.
Evidence precedence, highest first, is provider, trusted tool counter, exact reconstruction, then estimate. Two receipts with the same complete correlation-key set collapse to the higher-authority receipt. A partial overlap or an equal-authority conflict between two receipts fails the import closed, because a daily aggregate cannot safely subtract only the overlapping requests.
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
Documented conventions for extractors you write against this contract. Only the ollama capture ships with this release; the rest describe how a provider-specific extractor should key its receipts so the reconciliation rules in `scripts/lib/receipt-schema.js` apply correctly.
| Source convention | Key | Rule |
|---|---|---|
| claude_code | requestId | Latest timestamp wins. A streamed turn rewrites the same request under earlier partial counts before it settles. |
| perplexity_api | response id | The API response's own identifier. Two independent captures of the same call reconcile to one receipt instead of double counting. |
| typesafe_api | SHA-256 of the canonical response | No request id is exposed, so byte-identical responses collapse to one receipt. |
| ollama | one receipt per captured call | Each relayed request and response pair is its own receipt; nothing is pre-aggregated before capture. |
| generic receipts | snapshot_key | Dominance rules apply: a higher token-and-call snapshot replaces a lower one, a lower one is rejected, and two snapshots that disagree in opposite directions fail the import closed. |
