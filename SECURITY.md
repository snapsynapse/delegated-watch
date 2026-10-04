# Security
## Supported versions
0.3.x is the only supported line. Earlier releases receive no fixes; upgrade to the latest 0.3 release before reporting.
## Reporting a vulnerability
Report privately through GitHub's private vulnerability reporting on this repository, not through a public issue: https://github.com/snapsynapse/delegated-watch/security/advisories/new
GitHub's own guide to the process is at https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability
## Credential and network boundaries
Hosted captures and provider-usage extractors read API or admin keys only from named environment variables. Keys are used for the explicitly selected provider request and are never written to receipts, configuration, logs, or generated pages. Capture commands relay request content to the endpoint the operator selected, but persist only model identity, counters, timestamps, and scrubbed provenance; provider-usage extractors request aggregate usage and do not send prompts. Local receipt and dataset files are not uploaded by the tool. `ollama:capture` defaults to `http://127.0.0.1:11434`, and `npm run dev` binds to `127.0.0.1` only.
## What a security-relevant change requires
A change that affects what data a shipped command reads, writes, or transmits needs a passing run of `npm test`, a passing run of every `eval:*` command, and a regression test that demonstrates the fixed behavior rather than only removing the symptom. A change that widens what the dev server binds to, what a capture tool contacts over the network, or what a build inlines into the static page is a design-invariant change and is recorded in `INTENT.md` first.
