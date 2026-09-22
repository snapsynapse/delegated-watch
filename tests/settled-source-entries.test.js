import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSettledEntriesIntact,
  loadSettledSourceEntries,
  partitionSettledReceipts
} from "../scripts/lib/settled-source-entries.js";

const row = (date, tokens = 4200000, calls = 900, byOrigin = { "machine/example-laptop": 4200000 }) => ({
  date,
  timezone: "UTC",
  sources: {
    codex: { tokens, calls, fidelity: "exact", by_origin: byOrigin },
    claude_code: { tokens: 25, calls: 1, fidelity: "exact" }
  },
  total: tokens + 25,
  driver: "building:infra",
  evidence: "test"
});

const settled = [
  { date: "2026-08-05", source: "codex", tokens: 4200000, calls: 900, reason: "test" }
];

const receipt = (date, source, tokens, origin) => ({
  date,
  source,
  tokens,
  fidelity: "exact",
  ...(origin ? { origin } : {})
});

const dataset = () => [row("2026-08-01", 1, 1), row("2026-08-05"), row("2026-09-01", 2, 2)];

test("receipts for a settled pair are dropped, others pass through", () => {
  const { kept, dropped } = partitionSettledReceipts(
    [
      receipt("2026-08-05", "codex", 3900000, "machine/example-laptop"),
      receipt("2026-08-05", "claude_code", 500),
      receipt("2026-08-06", "codex", 123)
    ],
    settled,
    dataset()
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].tokens, 3900000);
  assert.deepEqual(
    kept.map((r) => `${r.date}/${r.source}`),
    ["2026-08-05/claude_code", "2026-08-06/codex"]
  );
});

test("a settled pair with no receipt this run keeps everything", () => {
  const { kept, dropped } = partitionSettledReceipts(
    [receipt("2026-09-07", "codex", 1)],
    settled,
    dataset()
  );
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
});

test("a receipt from an origin the frozen entry lacks is refused, not dropped", () => {
  // The other machine's store may be intact, so this is the one thing that
  // could restore the loss. Silently discarding it would understate by_origin
  // for good.
  assert.throws(
    () =>
      partitionSettledReceipts(
        [receipt("2026-08-05", "codex", 4000, "example-laptop")],
        settled,
        dataset()
      ),
    /receipts from an origin they do not contain.*example-laptop/s
  );
});

test("settled entries must match the committed row on tokens and on calls", () => {
  assert.doesNotThrow(() => assertSettledEntriesIntact(dataset(), settled));
  const wrongTokens = dataset();
  wrongTokens[1].sources.codex.tokens = 9000000;
  assert.throws(() => assertSettledEntriesIntact(wrongTokens, settled), /config pins 4200000\/900/);
  const wrongCalls = dataset();
  wrongCalls[1].sources.codex.calls = 1969;
  assert.throws(() => assertSettledEntriesIntact(wrongCalls, settled), /config pins 4200000\/900/);
});

test("an entry missing from a dataset that spans its date fails closed", () => {
  const stripped = dataset();
  delete stripped[1].sources.codex;
  assert.throws(
    () => assertSettledEntriesIntact(stripped, settled),
    /missing from the dataset, which covers 2026-08-01\.\.2026-09-01/
  );
});

test("a whole row deleted from inside the covered range still fails closed", () => {
  // The exclusions path can delete a row outright. Skipping absent rows would
  // let that pass forever while the receipts kept being discarded.
  const withoutRow = dataset().filter((r) => r.date !== "2026-08-05");
  assert.throws(() => assertSettledEntriesIntact(withoutRow, settled), /missing from the dataset/);
});

test("a dataset that does not span the date is left alone", () => {
  // Synthetic fixtures legitimately cover none of these dates.
  assert.doesNotThrow(() => assertSettledEntriesIntact([row("2020-01-01", 5, 5)], settled));
  assert.doesNotThrow(() => assertSettledEntriesIntact([], settled));
});

test("the real config loads, and no entry is both settled and excluded", async () => {
  const entries = await loadSettledSourceEntries();
  assert.ok(Array.isArray(entries));
  for (const entry of entries) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.reason.trim().length > 0, `${entry.date} needs a reason`);
    assert.ok(Number.isInteger(entry.tokens) && entry.tokens >= 0);
    assert.ok(Number.isInteger(entry.calls) && entry.calls >= 0);
  }
  const keys = entries.map((e) => `${e.date}/${e.source}`);
  assert.equal(new Set(keys).size, keys.length, "settled entries must be unique");
});

test("the committed dataset satisfies every settled entry", async () => {
  const { readFile } = await import("node:fs/promises");
  const rows = JSON.parse(await readFile("public/data/daily-burn.json", "utf8"));
  assertSettledEntriesIntact(rows, await loadSettledSourceEntries(), { label: "committed dataset" });
});
