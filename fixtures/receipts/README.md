# Synthetic receipt fixtures

Three JSONL files demonstrating `scripts/import-daily-burn.js` against the
synthetic dataset at `candidate/public/data/daily-burn.json`. `npm run
demo:import` runs all four in isolated temp copies and prints what happened.
Nothing here is measured. Every date, token count, and identity is invented;
every `provenance` string starts `synthetic:`; every `origin` and
`account_alias` comes from `config/public-candidate.json`
`reserved_identities`.

## day-one.jsonl

Four receipts across two sources (`codex`, `claude_chat`) and two origins
(`machine/example`, `account/example-provider`), for `2025-01-04` and
`2025-01-05` — dates absent from the synthetic dataset. The importer has no
existing row for either date, so both import as new rows with `driver:
"unreviewed"` and the standard "imported from local receipts; pending
review" evidence note. This is the ordinary path: new evidence, nothing to
reconcile against.

## regression.jsonl

One receipt for `2025-01-02`/`codex`, a pair the synthetic dataset already
carries at `36327` exact tokens. This receipt claims `10000` — lower, still
`fidelity: "exact"`. `scripts/lib/import-policy.js`
`assertHistoricalPreservation` refuses it: an exact counter may not decrease
without `--allow-decrease --confirm-correction --correction-reason`, because
a lower reading of the same day is normally evidence loss, not a correction
(see the no-decrease gate in `DATA_CONTRACT.md`).
The import exits nonzero and writes nothing.

## estimated.jsonl

One receipt for `2025-01-09`, which the synthetic dataset already carries as
two `exact` sources (`codex`, `openai_api`). This receipt adds `claude_chat`
at `fidelity: "estimated"`. The importer merges it as a new source entry on
the existing row without touching the exact entries already there — a
day can hold exact and estimated sources side by side, and the row's mixed
fidelity is exactly what the dashboard is built to render honestly rather
than average away.

## The runtime-generated fourth scenario

`npm run demo:import` also builds one receipt in memory, dated the current
UTC day, and imports it into its own temp copy. It is never written to this
directory: a fixture dated "today" goes stale the day after it is committed,
and silently stops demonstrating the cutoff it exists to show. The importer
holds it back and says so — "Held back 1 receipt(s) for `<today>`: not yet a
complete day in UTC" — and the temp dataset is left unchanged, per the cutoff gate in `DATA_CONTRACT.md`
"The tally cuts at midnight; the current day is never imported."

## Settled entries, described but not demonstrated

`config/settled-source-entries.json` freezes a `(date, source)` pair whose
committed figure is the last complete measurement, because the store that
produced it no longer holds the evidence (see `scripts/lib/settled-source-entries.js`
and `DATA_CONTRACT.md` "Settled entries freeze a measurement whose evidence is
gone"). Demonstrating it against the synthetic dataset would need a
`config/settled-source-entries.json` scoped to synthetic dates, which the
importer does not currently support pointing at an alternate path — that
would be a change to `scripts/lib/settled-source-entries.js`, out of scope
here. The shape of an entry:

```json
{
  "date": "2025-01-02",
  "source": "codex",
  "tokens": 36327,
  "calls": 3,
  "reason": "Example: local store depleted before re-extraction",
  "decision": "a link to the written decision that settled this pair",
  "settled_on": "2025-01-03"
}
```

With an entry like this in `config/settled-source-entries.json`, importing
`regression.jsonl` above would be dropped silently (logged as "Dropped ...
receipt(s) for settled entries") instead of refused — the entry pins the
figure so the gate never has to fire on that pair again.
