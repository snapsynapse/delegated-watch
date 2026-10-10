Status: deferred per ROADMAP.md until accounting risks are quarantined; design record, not a queue

Original handoff metadata: dated 2026-10-02, baseline commit 50bee87d66b7ab11392c7da480e477cea78982b6.


# OpenAI token reporting change watch design

## Recommendation and boundaries

Implement an opt-in daily deterministic watcher for official documentation and selected Codex source. Fetch, normalize, hash, and retain evidence first. Use an optional bounded model only to interpret relevant changes. Detection must work without a model or provider key.

**This document is a design, not an enabled watch.** No repository changes, scheduled workflow, notifications, credentialed queries, or live model calls were made. Implement and enable it separately. This watch identifies measurement opportunities and contract changes; it neither collects personal usage nor changes token totals. Currency, prices, credits, and product-allowance estimates are excluded.

At the [reviewed repository commit](https://github.com/snapsynapse/delegated-watch/tree/50bee87d66b7ab11392c7da480e477cea78982b6), [package.json](https://github.com/snapsynapse/delegated-watch/blob/50bee87d66b7ab11392c7da480e477cea78982b6/package.json) uses Node ES modules and `node --test`; [README](https://github.com/snapsynapse/delegated-watch/blob/50bee87d66b7ab11392c7da480e477cea78982b6/README.md) specifies no runtime dependencies. The [current workflow](https://github.com/snapsynapse/delegated-watch/blob/50bee87d66b7ab11392c7da480e477cea78982b6/.github/workflows/ci.yml) is manual, SHA-pinned, and read-only by default. Rebase conventions before implementation. Keep this optional networked utility outside `refresh`, import, and dashboard builds; update documentation to disclose it.

## Explicit source manifest

Use stable IDs, exact allowlisted URLs/paths, extraction rules, expected headings/symbols, content-type/size limits, and a manifest version. No whole-site crawl or automatic expansion from links.

| Source | Initial selection and purpose |
| --- | --- |
| [Desktop reporting](https://help.openai.com/en/articles/20001478) | Eligibility, token-history components, coverage, Personal Analytics prerequisites and scope |
| [Meet dots](https://learn.chatgpt.com/docs/dots) | Any newly documented counters, export, telemetry, or surface distinctions |
| [Cloud and local access](https://learn.chatgpt.com/docs/enterprise/cloud-local-access) | Coordination/execution boundaries relevant to where usage evidence could exist |
| [Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) | Result schemas, component definitions, grouping, buckets, pagination, supported token-bearing endpoints |
| Official `openai/codex` | `codex-rs/protocol/src/protocol.rs`, `codex-rs/core/src/thread_manager.rs`, `codex-rs/core/src/session/mod.rs`, `codex-rs/rollout/src/policy.rs` |

For Codex, resolve its default-branch HEAD once per run and fetch all selected files at that immutable commit. Hash token structures/events/helpers and fork/persistence sections with their comments and surrounding declarations; retain full raw files. Anchor findings to commits, not moving branches. The prior audit used [cb6da588](https://github.com/openai/codex/tree/cb6da58876afed3ede0ab11084f67dd5394ecb48); its [protocol](https://github.com/openai/codex/blob/cb6da58876afed3ede0ab11084f67dd5394ecb48/codex-rs/protocol/src/protocol.rs#L2241-L2350) contains TokenUsage, TokenUsageInfo, and TokenCountEvent. Removed or renamed symbols require review rather than a successful empty extraction.

An official releases Atom feed can be an optional discovery cue after its endpoint and parser are tested. It is not required or verified here, and a release alone is not a reporting change.

## Current coverage boundaries

The [Desktop article](https://help.openai.com/en/articles/20001478) currently applies to eligible Enterprise/Edu workspaces, with rollout/admin prerequisites. It describes uncached input, cached input, and output history for Work/Codex and excludes regular Chat from those views. It does not establish Pro availability, a machine-readable export contract, or complete dot coverage. Keep Enterprise/Edu and consumer-plan applicability separate.

[Consumer export guidance](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) currently includes Pro and eligible Edu settings exports; Enterprise self-service export is unavailable. This is contextual guidance, not an additional initial watched source unless the owner adds it. Conversation text supports an estimate; it does not reconstruct hidden reasoning, repeated context, tools, workers, or missing multimodal traffic.

Dot documentation distinguishes cloud work from connected-computer execution. That boundary is not proof of accessible counters. Main dot conversations, voice, cloud workers, and hosted/remote tasks remain **unknown** until an accessible, verified source supplies usage. Local dot-created Codex tasks may already be covered by rollout receipts; verify before adding an additive dot source.

## Deterministic collection and normalization

1. Load and validate persisted state before network access. A missing first-run state requires explicit bootstrap; malformed existing state must never trigger rebootstrap.
2. Fetch each source independently with timeout, bounded retries/backoff, and response-size limits. Use stored ETag/Last-Modified conditional requests. A 304 is valid only with its matching verified cached body; otherwise retry an unconditional GET.
3. Validate successful status, expected content type, main content, required headings/symbols, and completeness checks. Reject login/bot/error pages, empty bodies, truncation, and implausible extraction collapse. Reject oversize responses explicitly; never silently truncate evidence.
4. Retain raw bytes and SHA-256. Normalize main content, strip navigation/footer/scripts and volatile relative update labels, and collapse non-semantic whitespace. Preserve ordered headings, links, tables and their row/column relationships, code/schema fields, punctuation, numbers, eligibility wording, and comments defining semantics. Record absolute publication/update dates separately where supplied. Test HTML extraction; prefer a Markdown endpoint only after verified equivalent extraction.
5. Compare per-section normalized hashes with the last valid fetched revision. Layout-only changes record an observation without a semantic candidate. Newly added or removed main-content sections enter review even without existing keywords; keyword filtering cannot discard eligibility or schema changes.
6. Persist validated observations and immutable transition records atomically before interpretation or notification. One failed source cannot erase another source's successful change.

404/410, unexpected redirects, and moved pages create a source-health/contract-review event; they do not silently replace a baseline with an empty page or new URL. A same-article canonical slug redirect is allowed only by a tested manifest rule and is recorded. Other destinations require review. Never follow redirects outside the allowlist or execute instructions embedded in fetched documents, source comments, or model output.

## State and review semantics

Propose a versioned JSON manifest plus content-addressed evidence objects and append-only transitions. Every source stores:

- Config/normalizer versions; requested/final URL or repository/path; commit/blob anchors
- ETag, Last-Modified, response status, raw/normalized SHA-256, section hashes
- UTC observed time and separately nullable source-published/updated time; never derive an exact publication date from “updated recently”
- Latest valid fetched revision, last contiguous reviewed revision, health/failure streak, immutable pending changes

Every change stores before/after evidence references, section anchors and excerpts, verdict (`pending`, `irrelevant`, `material_verified`, `uncertain`), verification rationale, collector/test recommendations, and notification status. Advancing the fetched revision never acknowledges a pending review. Preserve pending changes across model failure, disabled analysis, later fetches, and notification failure. Review revisions in order per source.

Bootstrap records current valid evidence with `baseline_initialized`, explicitly without a “new feature” alert; sources that fail bootstrap remain uninitialized. An A→B→A reversion remains two transitions with retained evidence, even if review was delayed. Dedup by SHA-256 of source ID, normalizer version, immutable before/after revision IDs, and occurrence sequence. Retries reuse the transition ID; a later repeated transition is a new occurrence linked to prior findings.

Use generation numbers and expected previous-state hashes for optimistic concurrency, write to a temporary tree, validate every referenced object, then publish atomically. On corruption, retain the damaged state and restore only a verified backup with an explicit incident record. Never claim an unchanged source while its last check failed.

## Optional bounded semantic analysis

Default `analysis.enabled=false`. Deterministic diffs and a pending-review report remain fully usable. Verified schema/eligibility rules or human review can establish materiality without a model; unresolved semantic candidates remain pending/uncertain.

If enabled later, configure provider, exact model ID, and supported reasoning setting explicitly. Choose the smallest suitable model against fixtures rather than inventing a model name. Proposed limits: two calls per daily run; 6,000 input tokens and 1,000 output tokens per call, including instructions/schema; at most 20 changed sections. Count against the chosen tokenizer, leave margin, and defer overflow intact. No automatic escalation or unbounded retries. Record provider-reported analysis token usage separately from the user's usage dataset; unavailable usage remains unavailable.

Send only public before/after excerpts, source metadata, and a static token-only accounting contract. Exclude private rollouts, exports, account IDs, prompts, and credentials. Require owner approval before enabling provider egress or granting persistent access. Keep secrets in the approved runtime secret store, never commits or logs. Treat excerpts as untrusted data; provide no browsing, shell, write, or notification tools to the analyzer.

Require structured output: claim, affected plans/surfaces, exact evidence spans, changed token semantics, confidence/uncertainty, recommended collector/tests. Validate schema and evidence references. Model confidence is not verification; unsupported or ambiguous output cannot create a material alert or advance review as resolved.

## Material findings and delivery

A material finding changes availability/access to measurable tokens, reporting/export contracts, counter definitions, missing-versus-zero meaning, aggregation/day boundaries, overlap/lineage, cache or reasoning containment, or attribution coverage. Cosmetic UI changes and release notes unrelated to measurement do not qualify.

Each verified alert must include:

- What changed and who it affects: Pro/consumer, Enterprise/Edu, organization API, or unknown
- Surface and route: Chat, Work, Codex, dot, local/cloud, subscription/API-key where established
- Before/after source spans, hashes, immutable commit links where applicable, UTC observation and nullable published date
- Exact measurement implication and a concrete collector/schema/test recommendation, with uncertainty explicitly labeled

Map API schema changes to `extract-openai-api.js`/`lib/openai-usage.js` and API fixtures; Codex protocol/fork changes to `extract-codex.js` and fork fixtures; export changes to `estimate-chatgpt.js`; genuinely new coverage to `SURFACES.md`. Verify current paths at implementation time. Preserve the current headline, non-cached input plus output; never add cached input twice or reasoning to an output total already containing it. New cache-write fields require source-specific contract review, not a guessed formula change.

Delivery is initially a local/Actions report. Owner must choose and authorize an exact notification destination, for example a reporting-change issue in `snapsynapse/delegated-watch`. That choice is pending; no issue creation or external send is implied. Persist an outbox before sending and record the provider result. An uncertain send requires destination reconciliation by stable transition ID before retrying.

## Proposed repository integration and operations

Add `config/openai-reporting-watch.json`, `scripts/watch-openai-reporting.js`, small `scripts/lib/reporting-watch/` modules, `tests/openai-reporting-watch.test.js` with scrubbed public fixtures, and a separate `.github/workflows/openai-reporting-watch.yml`. Proposed future commands, not existing commands:

```bash
node scripts/watch-openai-reporting.js --bootstrap --state-dir scratch/reporting-watch
node scripts/watch-openai-reporting.js --check --state-dir scratch/reporting-watch
node scripts/watch-openai-reporting.js --review CHANGE_ID --verdict material_verified
```

Use Node 24 within the verified engine range, built-in fetch/crypto/test where practical, and the repository's pinned Actions convention. Any HTML parser dependency must be explicit and tested. Default workflow permissions to `contents: read`; isolate optional state persistence (`contents: write`) and approved issue delivery (`issues: write`) in narrowly scoped jobs. Never use user admin keys for public documentation checks.

Recommend a dedicated `reporting-watch-state` branch for public evidence/state, excluded from deployment/build inputs. Its isolated persistence job publishes only validated data, never fetched executable files. Serialize all daily/manual/review runs with one concurrency group and `cancel-in-progress: false`; also compare expected branch HEAD before commit. Conflicts reload and merge by transition IDs or fail safely.

Actions artifacts are diagnostic backups, not the only durable baseline: they expire or can be deleted. Retain raw/normalized evidence and all unresolved transitions on the state branch; configure a tested 30-day artifact retention within repository limits. Never prune objects referenced by pending reviews or undelivered alerts. [GitHub artifact guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts) explains retention/deletion.

Propose UTC cron `17 8 * * *`, adjustable by the owner, plus manual dispatch. This is a daily target, not an exact local-time delivery promise. [GitHub schedule guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) documents default-branch execution, delays, and public-repository inactivity disabling. Record run liveness; a scheduler that never runs cannot diagnose itself.

After three consecutive failed daily observations, emit one source-health incident, with recovery notification only if that incident was delivered. Model backlog and scheduler liveness have separate health states. Manual dry runs produce reports and mutate no durable state or destinations.

## Acceptance and definition of done

Fixtures must cover bootstrap without alert; irrelevant layout/navigation; semantic field and eligibility changes; preserved tables/headings; valid 304 and missing-cache retry; empty/corrupt/403/truncated/oversize responses; removed source/symbol and redirects; per-source partial failure; provider failure with retained pending diffs; repeated diff without duplicate delivery; reversion and later recurrence; corrupted state and concurrent writers; uncertain notification reconciliation; and analyzer prompt-injection text producing no actions.

Run the existing `npm test` and the documented CI checks after implementation; report passed, failed, and unrun stages. Verify manually with public fixture-driven transitions, then one owner-approved baseline/check run. Done means durable evidence survives restart, pending changes survive every failure path, meaningful changes yield grounded recommendations, irrelevant changes stay quiet, health failures remain visible, and no watch result modifies accounting totals. Enable scheduling only after the owner accepts source coverage, persistence, and delivery.

Owner decisions: confirm UTC schedule; approve state-branch writes/retention; choose exact notification destination; decide deterministic/manual review versus optional provider analysis and its explicit configuration. The daily design is recommended; implementation and activation remain outstanding.
