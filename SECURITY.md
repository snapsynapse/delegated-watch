# Security
## Supported versions
0.2.x is the only supported line. Earlier releases receive no fixes; upgrade to the latest 0.2 release before reporting.
## Reporting a vulnerability
Report privately through GitHub's private vulnerability reporting on this repository, not through a public issue: https://github.com/snapsynapse/delegated-watch/security/advisories/new
GitHub's own guide to the process is at https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability
## What is not exposed
No shipped command reads a credential of any kind. There is no environment variable, config file, or command-line flag in this candidate that accepts an API key. `ollama:capture` relays a request to a local Ollama endpoint only, defaulting to `http://127.0.0.1:11434`; it holds no credential and makes no other network call. `npm run dev` binds to `127.0.0.1` only and is not reachable from another device.
## What a security-relevant change requires
A change that affects what data a shipped command reads, writes, or transmits needs a passing run of `npm test`, a passing run of every `eval:*` command, and a regression test that demonstrates the fixed behavior rather than only removing the symptom. A change that widens what the dev server binds to, what a capture tool contacts over the network, or what a build inlines into the static page is a design-invariant change and is recorded in `INTENT.md` first.
