# Contributing
## Ground rules
Zero runtime dependencies is a rule, not a preference. A pull request that adds a runtime dependency to make one script shorter will be asked to remove it instead.
`node --test` runs against synthetic fixtures only. Never commit a test, a fixture, or an example that carries a real usage figure, a real date of activity, or any other value read from an actual account. If a test needs realistic-looking data, generate it synthetically the way `demo:data` does.
Design invariant 10, see `INTENT.md`, applies to every read a change adds: a failed read and an absent one are different findings, and code that collapses them together will be rejected. `npm run eval:code` checks for the pattern statically.
## Commit messages
Present tense, and focused on the mechanism changed rather than a narrative of why it seemed like a good idea: "Add cutoff check to the importer" rather than "Added a check because we needed one."
## Changing a design invariant
A change to any invariant in `INTENT.md` is a change to that document first, in the same pull request as the code, never a code change with the invariant text updated afterward to match.
## Running the suite
Literal
```bash
npm test
npm run validate
npm run eval
npm run eval:code
npm run eval:dashboard
npm run eval:served
```
## Proposing an extractor
This release ships one capture, `ollama:capture`, and no provider-specific extractors. A new extractor for a provider, a chat surface, or an IDE extension needs, at minimum:
- Conformance to the receipt contract in `DATA_CONTRACT.md`, including `schema_version: 2` and a dedupe key documented in its "Dedupe keys" table.
- A verified dependency closure against the store it reads: know exactly which files or endpoints it touches and what changes their shape.
- A test proving that an absent source reads as unavailable, never as a measured zero. This is the single most important test a new extractor can carry, because a script that gets it wrong produces a dataset that looks complete and is not.
- Read-only access to every source it touches, and no assumption that extraction runs exactly once.
