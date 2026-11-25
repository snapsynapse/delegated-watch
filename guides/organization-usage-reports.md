# Organization usage reports
Use this when you or your organization call the Anthropic or OpenAI API with organization keys. The organization usage reports are the provider's own count of every call made with those keys, whichever client made it.
This guide needs your own source: an organization admin key. Nothing synthetic exercises a live provider report.
## Keep the key out of history
Each extractor reads an admin key from its environment variable and skips cleanly without one. Never commit a key, paste it into a chat, or type it on a command line, where shell history keeps it. Reading it without echo avoids all three.
## Anthropic
After this command starts, the shell waits silently: paste the Anthropic admin key, which is not shown, and press Return.
Literal
```bash
read -rs ANTHROPIC_ADMIN_KEY && export ANTHROPIC_ADMIN_KEY && npm run extract:claude-api
```
## OpenAI
OpenAI also requires a stable, non-secret organization scope because a display alias alone cannot distinguish two organizations. Before running the extractor, add exactly one matching account entry to `config/openai-reconciliation.json`. The entry must provide `account_alias`, `organization_scope`, and `mode`; a non-`unset` mode also requires `decided_on` and human-reviewed `evidence`. Each organization scope may appear in only one entry, although separate scopes may share a display alias. Set `OPENAI_ACCOUNT_ALIAS` to the configured alias, or leave it unset for `primary`.
After this command starts, the shell first prompts `OpenAI organization scope: `; enter the configured non-secret scope and press Return. It then waits silently; paste the organization admin key, which is not shown, and press Return.
Literal
```bash
read -rp "OpenAI organization scope: " OPENAI_ORGANIZATION_SCOPE && export OPENAI_ORGANIZATION_SCOPE && read -rs OPENAI_ADMIN_KEY && export OPENAI_ADMIN_KEY && npm run extract:openai-api
```
## Reconcile before the report counts
An organization report covers every client that used its keys, so it can overlap a local extractor that counted the same calls: Claude Code or Codex signed in with an API key, or an editor extension or agent pointed at the same organization.
- Anthropic receipts are held in `scratch/reconcile/` until `npm run reconcile:claude` compares them with your Claude Code record and you record a verdict in `config/claude-reconciliation.json`.
- OpenAI organization receipts also default to `scratch/reconcile/`. `config/openai-reconciliation.json` must record account-specific human scope evidence before an `additive` decision makes them importer-visible.
Equal daily totals do not prove overlap, subscription Codex is not presumed to use an organization's API keys, and an `overlapping` decision keeps the full organization report as non-additive evidence rather than subtracting an estimated portion.
## What each exit means
- 0: the report was read, or no key is set and nothing was asked of the provider.
- 1: the provider returned an error, including a rejected key.
- 3: the provider could not be contacted. This run knows nothing about the window, which is unknown, not a measured zero.
`npm run refresh` checks each key that is set with `npm run check:credentials` before the matching extractor runs, using the same exit codes. A rejected key exits 1 and an unreachable provider exits 3, which says nothing about whether the key is good.
## When the preflight says unreachable but the network works
An `unreachable` result while curl reaches the same host points at the Node binary, not the network. One cause: a per-binary firewall or network filter whose rule was bound to the old binary, so a Node upgrade installs a new binary the filter blocks. The error code is typically `EBADF` or a connect timeout.
Compare the two from the same shell. The command needs no key and sends none.
Literal
```bash
curl -sS -m 10 -o /dev/null -w 'curl %{http_code}\n' https://api.anthropic.com/v1/models; node -e 'fetch("https://api.anthropic.com/v1/models").then(r=>console.log("node",r.status)).catch(e=>console.log("node err",e.cause?.code))'
```
When both reach the host, each prints an HTTP status, 401 without a key. A `curl` status beside `node err EBADF` or a connect timeout means the Node binary is being blocked. Allow the current Node binary in the filter, then run the preflight again.
## What it cannot see
A report counts only calls made with that organization's keys. Provider-side web search and research steps inside a response carry no token count at all. The state of each hosted API is in [SURFACES.md, hosted APIs and gateways](../SURFACES.md#hosted-apis-and-gateways).
