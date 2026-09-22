# Privacy
## What enters the record
Each row and each receipt carries only: date, source, tokens, calls, fidelity, an origin alias, a driver category, and a scrubbed evidence phrase describing a work family. Nothing else is retained.
## What never does
Prompts, responses, and transcripts never enter a receipt or the dataset. Conversation or document titles never enter it either; a reviewer may look at one locally, but only a generic description of the review signal is committed. Secrets, credentials, API keys, and auth artifacts never enter it. File paths, account ids, and other customer data never enter it.
## The privacy gate
`npm run privacy:receipts` is a read-only scan across every retained receipt source and every daily label. It fails on secret-shaped strings, URLs, local file paths, email addresses, markup, and evidence text longer than a short generic phrase should be. It cannot prove that ordinary prose contains no private identity, so scrubbing at the point of capture remains the primary control and the scan is a backstop, not a substitute.
## Origins and aliases are labels
An origin or machine alias in a receipt is a configured label chosen by whoever runs the extractor, such as `machine/example`, never a hostname, IP address, or device identifier read from the system. An account alias is the same: a chosen label, not a raw account id or email address. Nothing here fingerprints a device or a person.
## What the built page inlines
The static dashboard build inlines the dataset itself, plus narrow, reduced projections of two supporting configuration files: an interval register, holding timezone and each source interval's start, end, and status only, and an evidence manifest, holding aggregate receipt, request, and coverage counts only. Neither projection carries evidence text, request identity, correlation hashes, snapshot keys, or account or machine aliases.
## The dev server
`npm run dev` binds to `127.0.0.1` only. It is not reachable from another device on the network, and it serves the same self-contained build that `npm run build` produces, so previewing locally never opens a wider surface than the shipped artifact.
