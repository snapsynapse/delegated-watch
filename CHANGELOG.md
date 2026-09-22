# Changelog
All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`INTENT.md` carries the decision log: why choices were made. This file records what changed.
## [Unreleased]
### Added
- Social card art at `imgs/og.png` and `docs/imgs/og.png`, referenced from the page's OpenGraph, Twitter, and structured-data metadata.
- Issue and pull request templates under `.github/`.

## [0.1.0] - 2026-09-22
### Added
- First public release of the candidate tree: receipt schema v2, a deterministic importer with cutoff, no-decrease, settled-entry, exclusion, and reconciliation gates, and a single normalized dataset file.
- Static dashboard build and a loopback-only local dev server that serve the same self-contained page.
- CSV export, an evidence manifest and validator, and a read-only privacy scan over retained receipts and labels.
- The Anthropic API reconciliation oracle for comparing provider-reported usage against transcript-derived usage.
- One reference capture, for local inference through Ollama, that persists only model identity and authoritative counters.
- A synthetic demonstration dataset and fixture receipts, plus tooling to assemble and verify this candidate tree against its own inventory.
### Not included
- Provider-specific extractors for hosted chat products, IDE extensions, or organization usage APIs.
- The scheduled automation that runs a private pipeline unattended.
- Any real usage data. Every row shipped in this release is synthetic.
