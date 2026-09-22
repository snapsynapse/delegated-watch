import { readFile } from "node:fs/promises";
import { loadSourceEntryExclusions } from "./source-entry-exclusions.js";

const CONFIG_URL = new URL("../../config/settled-source-entries.json", import.meta.url);

const keyOf = (entry) => `${entry.date}/${entry.source}`;

export const loadSettledSourceEntries = async () => {
  const parsed = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  if (!Array.isArray(parsed.entries)) {
    throw new Error("config/settled-source-entries.json entries must be an array");
  }
  const seen = new Set();
  for (const entry of parsed.entries) {
    const key = keyOf(entry);
    if (seen.has(key)) throw new Error(`Duplicate settled source entry: ${key}`);
    seen.add(key);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? "") ||
      !/^[a-z0-9_]+$/.test(entry.source ?? "") ||
      !Number.isInteger(entry.tokens) ||
      entry.tokens < 0 ||
      !Number.isInteger(entry.calls) ||
      entry.calls < 0 ||
      !entry.reason?.trim()
    ) {
      throw new Error(`Invalid settled source entry: ${key}`);
    }
  }

  // Settling freezes an entry; excluding deletes it. Applying both to one pair
  // deletes the row and then permanently discards the receipts that could
  // rebuild it, with every downstream check passing. Refuse the combination
  // rather than trying to order them.
  const excluded = new Set((await loadSourceEntryExclusions()).map(keyOf));
  const overlap = [...seen].filter((key) => excluded.has(key));
  if (overlap.length) {
    throw new Error(
      `Source entries cannot be both settled and excluded: ${overlap.join(", ")}. ` +
        "Settling retains and freezes an entry; excluding removes it. Choose one."
    );
  }
  return parsed.entries;
};

// A settled entry must still be present wherever the dataset covers its date.
// Scoped by the dataset's own date range rather than skipping every absent row,
// because the importer also runs against synthetic fixtures that legitimately
// cover none of these dates. Inside the covered range a missing entry means the
// record lost something it should hold, which is exactly what must not pass
// unnoticed: the receipts that could rebuild it are being discarded every run.
export const assertSettledEntriesIntact = (rows, settled, { label = "dataset" } = {}) => {
  if (!rows.length) return;
  const dates = rows.map((row) => row.date);
  const covers = { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) };
  const rowsByDate = new Map(rows.map((row) => [row.date, row]));

  for (const entry of settled) {
    if (entry.date < covers.from || entry.date > covers.to) continue;
    const committed = rowsByDate.get(entry.date)?.sources?.[entry.source];
    if (!committed) {
      throw new Error(
        `Settled source entry ${keyOf(entry)} is missing from the ${label}, which covers ` +
          `${covers.from}..${covers.to}. Its receipts are being discarded every run, so the entry ` +
          "cannot rebuild itself. Restore it, or remove it from config/settled-source-entries.json."
      );
    }
    if (committed.tokens !== entry.tokens || committed.calls !== entry.calls) {
      throw new Error(
        `Settled source entry mismatch for ${keyOf(entry)} in the ${label}: config pins ` +
          `${entry.tokens}/${entry.calls}, ${label} holds ${committed.tokens}/${committed.calls ?? "n/a"}.`
      );
    }
  }
};

// Receipts for a settled pair are re-derivation from a depleted store and are
// dropped. A receipt from an origin the frozen entry never contained is not
// re-derivation: it is evidence from a machine whose store may be intact, and
// it is the one thing that could restore the loss. Silently dropping it would
// keep by_origin understated forever, so it is refused for human review.
export const partitionSettledReceipts = (receipts, settled, rows = []) => {
  const frozen = new Map(settled.map((entry) => [keyOf(entry), entry]));
  const rowsByDate = new Map(rows.map((row) => [row.date, row]));
  const kept = [];
  const dropped = [];
  const foreign = [];

  for (const receipt of receipts) {
    const key = keyOf(receipt);
    if (!frozen.has(key)) {
      kept.push(receipt);
      continue;
    }
    const byOrigin = rowsByDate.get(receipt.date)?.sources?.[receipt.source]?.by_origin;
    if (receipt.origin && byOrigin && !Object.hasOwn(byOrigin, receipt.origin)) {
      foreign.push(`${key} from ${receipt.origin}`);
      continue;
    }
    dropped.push(receipt);
  }

  if (foreign.length) {
    throw new Error(
      `Settled source entries received receipts from an origin they do not contain: ${foreign.join(", ")}. ` +
        "That is new evidence rather than re-derivation, and may be the store that can restore the loss. " +
        "Remove the affected entries from config/settled-source-entries.json and import deliberately."
    );
  }
  return { kept, dropped };
};
