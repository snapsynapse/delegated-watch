# Reading your record
A chart that cannot change the next decision does not belong on the dashboard. This page shows three questions the dashboard answers and the decision each answer informs.
Every number on this page comes from the shipped synthetic dataset, `public/data/daily-burn.json`, and none of it is anyone's measured usage. `tests/reading-your-record.test.js` recomputes each figure from that file, so a regenerated dataset fails the test instead of leaving this page wrong. Open the same view with `npm run dev` and its `/demo/` route.
## Which surface carries most of the delegated work?
The synthetic record holds 6,208,566 tokens across six sources:
| Source | Tokens | Share |
|---|---|---|
| `codex` | 1,819,909 | 29.3% |
| `openai_api` | 1,756,671 | 28.3% |
| `claude_code` | 1,506,061 | 24.3% |
| `claude_chat` | 428,494 | 6.9% |
| `qwen_local` | 388,817 | 6.3% |
| `perplexity_api` | 308,614 | 5.0% |
The decision it informs: where review effort goes. Three sources carry about four fifths of the work, so a review of what was delegated, and whether it was worth delegating, starts there. A token count says how much the model read and wrote, not how good or how valuable the work was, so the share ranks where to look, not what mattered.
## Where is evidence missing rather than zero?
The synthetic record spans 2025-01-02 to 2025-12-31, 364 days. 225 of them have a row. The other 139 have no row at all, and no row records a total of zero.
The decision it informs: whether to go looking for evidence before reading a gap as a quiet day. An absent day means nothing was recovered, not that nothing happened. In a real record, a run of absent days for a source that was in use points at a pruned log or a store that was never read, and a backup passed with `--root` or `--sessions` may recover it. See [Local agent transcripts](local-agent-transcripts.md).
## What does an estimated entry do to a total?
The dashboard's source mix says what each token rests on:
| Authority | Tokens | Share |
|---|---|---|
| `provider`, a provider's own counter | 1,756,671 | 28.3% |
| `tool`, a local tool's own counter | 3,325,970 | 53.6% |
| `estimated`, reconstructed at four characters per token | 1,125,925 | 18.1% |
The decision it informs: how much weight a total can carry. Here 18.1% of the total rests on estimates. Most of its parts are exact, and the total is still not an exact measurement. The consumer chat estimate is a floor, because it leaves out the context each turn re-sends. Before quoting a total, quote the split beside it, and before comparing two periods, check that the estimated share did not change between them. See [Consumer chat exports](consumer-chat-exports.md).
