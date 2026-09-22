// Verify the persistent accepted-evidence ledger or check one incoming JSONL
// file against it. This command deliberately never scans receipt directories
// and never rewrites the durable manifest.
//
// Usage:
//   node scripts/build-evidence-manifest.js [--dry-run]
//   node scripts/build-evidence-manifest.js --check receipts.jsonl

import { readFile } from "node:fs/promises";
import {
  ACCEPTED_MANIFEST_PATH,
  assertNoPendingAcceptance,
  checkEvidenceOverlap,
  summarizeCoverage,
  validateAcceptedManifest
} from "./lib/accepted-evidence.js";
import {
  normalizeReceipt,
  validateReceiptSchema
} from "./lib/receipt-schema.js";
import { isCalendarDate } from "./lib/dataset-validation.js";

const args = process.argv.slice(2);
const checkIndex = args.indexOf("--check");
const checkFile = checkIndex === -1 ? null : args[checkIndex + 1];
const allowed = new Set(["--dry-run", "--check", checkFile]);
const unexpected = args.filter((arg) => !allowed.has(arg));

if (unexpected.length || (checkIndex !== -1 && !checkFile)) {
  console.error(
    "Usage: node scripts/build-evidence-manifest.js [--dry-run] [--check receipts.jsonl]"
  );
  process.exit(1);
}

try {
  await assertNoPendingAcceptance();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let manifest;
try {
  const manifestText = await readFile(ACCEPTED_MANIFEST_PATH, "utf8");
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    console.error("Invalid accepted evidence ledger: manifest is not valid JSON");
    process.exit(1);
  }
  validateAcceptedManifest(manifest);
} catch (error) {
  if (error.code === "ENOENT") {
    console.error(`No accepted evidence ledger at ${ACCEPTED_MANIFEST_PATH}.`);
  } else {
    console.error(`Invalid accepted evidence ledger: ${error.message}`);
  }
  process.exit(1);
}

if (checkFile) {
  let text;
  try {
    text = await readFile(checkFile, "utf8");
  } catch (error) {
    console.error(`Cannot read ${checkFile}: ${error.message}`);
    process.exit(1);
  }
  const receipts = [];
  const problems = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let receipt;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push(`${checkFile}:${index + 1} must be a receipt object`);
        continue;
      }
      receipt = normalizeReceipt(parsed);
    } catch {
      problems.push(`${checkFile}:${index + 1} is not valid JSON`);
      continue;
    }
    const where = `${checkFile}:${index + 1}`;
    if (!isCalendarDate(receipt.date)) {
      problems.push(`${where} has invalid date`);
    }
    if (!/^[a-z0-9_]+$/.test(receipt.source ?? "")) {
      problems.push(`${where} has invalid source`);
    }
    if (!Number.isSafeInteger(receipt.tokens) || receipt.tokens < 0) {
      problems.push(`${where} has invalid tokens`);
    }
    problems.push(...validateReceiptSchema(receipt, where));
    receipts.push(receipt);
  }
  if (!receipts.length && !problems.length) {
    problems.push(`${checkFile} contains no receipts`);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }

  let report;
  try {
    report = checkEvidenceOverlap(manifest, receipts);
  } catch (error) {
    console.error(`Cannot check incoming evidence: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `${checkFile}: ${report.receipts} receipts, ` +
      `${report.identified_requests} identified requests.`
  );
  console.log(
    `  already counted: ${report.already_counted_requests} requests, ` +
      `${report.snapshot_hits} snapshot keys ` +
      `(${report.replayed_older_snapshots} historical-version replays).`
  );
  console.log(
    `  new: ${report.new_requests} requests, ${report.new_snapshots} snapshots; ` +
      `${report.evolved_snapshots} snapshot evolutions.`
  );
  if (report.legacy_unverified_hits) {
    console.error(
      `  UNVERIFIED HISTORY: ${report.legacy_unverified_hits} receipt overlaps require acceptance or migration.`
    );
  }
  if (report.uncheckable.length) {
    console.error(
      `  UNCHECKABLE: ${report.uncheckable.length} receipts carry no correlation or snapshot key ` +
        `(${[...new Set(report.uncheckable)].slice(0, 5).join(", ")}` +
        `${report.uncheckable.length > 5 ? ", ..." : ""}).`
    );
  }
  if (report.conflicts.length) {
    console.error(
      ["  CONFLICTING HISTORY:", ...new Set(report.conflicts)].join("\n    ")
    );
  }
  if (report.snapshot_variants.length) {
    console.error(
      ["  UNRECOGNISED SNAPSHOT HISTORY:", ...new Set(report.snapshot_variants)]
        .join("\n    ")
    );
  }
  if (
    report.uncheckable.length ||
    report.conflicts.length ||
    report.legacy_unverified_hits ||
    report.snapshot_variants.length
  ) {
    process.exit(1);
  }
  process.exit(
    report.replay_receipts ||
      report.already_counted_requests ||
      report.snapshot_hits
      ? 2
      : 0
  );
}

const { entries } = validateAcceptedManifest(manifest);
const coverage = summarizeCoverage(entries);
const accepted = entries.filter((entry) => entry.acceptance === "accepted").length;
const legacy = entries.length - accepted;
console.log(
  `Verified ${entries.length} persistent evidence entries at ${ACCEPTED_MANIFEST_PATH}: ` +
    `${accepted} accepted, ${legacy} legacy-unverified, ` +
    `${manifest.identified_requests} identified requests.`
);
for (const [source, summary] of Object.entries(coverage)) {
  console.log(
    `  ${source.padEnd(14)} ${String(summary.receipts).padStart(4)} receipts  ` +
      `${String(summary.identified_requests).padStart(6)} requests  ` +
      `${summary.dedupe}  ${summary.accepted_receipts} accepted`
  );
}
if (manifest.malformed_receipt_lines) {
  console.error(
    `${manifest.malformed_receipt_lines} historical receipt lines were malformed; ledger verification is not clean.`
  );
  process.exit(1);
}
