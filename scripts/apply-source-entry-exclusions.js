import { acceptDataset, assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
await assertNoPendingAcceptance();

import { readFile } from "node:fs/promises";
import {
  applySourceEntryExclusions,
  loadSourceEntryExclusions
} from "./lib/source-entry-exclusions.js";
import {
  assertSettledEntriesIntact,
  loadSettledSourceEntries
} from "./lib/settled-source-entries.js";

const DATA_FILE = "public/data/daily-burn.json";
const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
const beforeRows = structuredClone(rows);
const exclusions = await loadSourceEntryExclusions();
const result = applySourceEntryExclusions(rows, exclusions);

// Loading settled entries also refuses any pair that is both settled and
// excluded, which would delete a row whose receipts are permanently discarded.
const settled = await loadSettledSourceEntries();
assertSettledEntriesIntact(result.rows, settled, { label: "corrected dataset" });

await acceptDataset({ beforeRows, rows: result.rows, receipts: [], excludedSources: result.removed });
console.log(
  `Applied ${result.removed.length} source-entry exclusions; ` +
    `${result.rows.length} daily rows remain.`
);
