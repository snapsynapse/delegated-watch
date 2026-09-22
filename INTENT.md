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
## Conformance philosophy
N/A because this repository is a product, not an open specification. It defines no conformance ladder for third parties. Its own claims are checked by the `eval:*` commands in `package.json`, which any clone can run.
## Admission criteria for changes
A change is admissible when it runs on canonical Node 24 LTS or the verified-compatible Node 26 line, `npm test` passes, `npm run validate` passes, and every configured `eval:*` command passes. A change to a design invariant above is recorded in this document before the code changes.
## Relationships to other PAICE standards
Non-binding. The repository adopts no PAICE standard as a conformance target today.
- HardGuard25: not adopted. The dataset is token-denominated but publishes no budget or limit metadata for LLM consumers, so the adopt-when condition does not hold.
- Graceful Boundaries: not applicable. There is no API or MCP surface, so there is no agent-facing refusal path to format.
- GuideCheck: not applicable. The site publishes no `assistant-guide.txt`.
- EveryAILaw: not cited. The published surface carries synthetic demonstration data and processes no one's personal record, so no live AI-regulation obligation attaches to it.
- AI Posture: not published. Publication is opt-in and no assertion has been elected for this subject.
## Exceptions to Repo Standards
- Accessibility gate is a source-contract test, not an axe run (2026-09-22). `tests/ui-accessibility-contract.test.js` asserts the accessible names, landmark roles, and visible focus treatment of every keyboard-scrollable region, and runs on every CI job. It is deterministic and blocking, which an axe scan of a single static page adds little to. The portfolio acceptance bar remains no major findings; this exception records the evidence form, not a lower bar. Revisit if the page gains interactive state beyond keyboard scrolling.
- No `llms-full.txt` at the site root (2026-09-22). `docs/llms.txt` inlines what a reader needs about the site rather than only linking out, which is the comprehensiveness criterion the hygiene matrix makes the OPTIONAL carve-out conditional on.

## Changelog
- 2026-09-22: added the canonical-page surface (head metadata, WebSite and SoftwareApplication JSON-LD, favicon, web manifest, 404, sitemap) and reversed the sitemap exception recorded earlier the same day.
- 2026-09-22: added Conformance philosophy and Relationships sections to complete the nine-section template; recorded the accessibility-evidence and `llms-full.txt` exceptions from the repo-standards walk.
- 2026-09-22 (0.1.0): first public release of this candidate tree.
