# Delegated.watch INTENT
## What this is
A local-first record of the work delegated to AI models, aggregated to one scrubbed row per day per source. Extractors and captures read provider logs and usage APIs read-only, emit receipt JSONL, and a deterministic importer merges them into a single normalized JSON file that a static page renders. Token counts are the unit; delegated work is the subject.
## Why it exists
Usage evidence is scattered across products that never reconcile with each other: local transcripts, organization usage APIs, consumer chat exports, IDE extension stores, and local runner ledgers. Each tool shows its own slice and calls it the total. Nothing distinguishes no usage from no evidence.
The framing comes from Nate B. Jones' post, [Build a Token Burn Dashboard to Track What Your AI Actually Does](https://natesnewsletter.substack.com/p/token-burn-dashboard): token burn is a proxy for delegated intelligence, and measuring it is a learning loop rather than a leaderboard. See `ATTRIBUTION.md` for lineage.
## Design invariants
Non-negotiable. A change that breaks one of these is a change to this document first.
1. Unknown is never zero. A day with no recovered evidence is absent from the dataset. A zero means a measured zero. The UI renders the two differently.
2. Fidelity is declared per source entry, as `exact` or `estimated`. Placeholder (`sample`) data may not exist in committed data.
3. Count each inference request once. Where a request appears in provider, gateway, extension, and local logs, dedupe on a stable request id and prefer the most authoritative exact counter.
4. Raw logs never enter the repo. Normalize outside, commit only scrubbed aggregates. `evidence` describes a work family or review source, never prompt text, customer data, private URLs, secrets, or transcripts.
5. Cache and reasoning token treatment is explicit and consistent across every extractor. Cache reads are excluded from headline counts and preserved in receipt provenance.
6. A shared account or subscription quota does not imply shared local history. Coverage must state the machine, account, surface, and interval it represents.
7. Provider or model identity and surface are separate dimensions. An IDE extension is a surface; the model behind it is a provider.
8. Personal values live in `config/`, not in code. Timezone, window start, and account or machine aliases are configuration. Scripts read them; scripts do not contain them.
9. Extraction is idempotent and read-only against every source it touches.
10. Interrogate every input before trusting it. A read that fails must be classified, not swallowed: does not exist and cannot be read are different findings, and only the first is evidence of absence. Any check that cannot distinguish them is a defect, whether it lives in code, in a script, or in a status report.
## Scope boundaries
In scope: a person-scoped, token-denominated record of delegated AI work across providers, interaction surfaces, and machines, including local inference.
Out of scope:
- Cost modeling, pricing tables, budgets, and spend alerts. Tokens are the unit; dollars are a separate concern with its own staleness problems.
- A backend. The dashboard is a static page over one JSON file.
- Any scoreboard framing, or a chart that cannot change the next decision.
- Centralizing raw logs anywhere, including in this repo.
## Admission criteria for changes
A change is admissible when it runs on canonical Node 24 LTS or the verified-compatible Node 26 line, `npm test` passes, `npm run validate` passes, and every configured `eval:*` command passes. A change to a design invariant above is recorded in this document before the code changes.
## Changelog
- 0.1.0: first public release of this candidate tree.
