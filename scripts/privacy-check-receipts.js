// Read-only gate covering every retained receipt source and all daily labels.
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { privateTextFindings, receiptPrivacyFindings } from "./lib/receipt-privacy.js";

let failures = 0;
let count = 0;
const fail = (where, rules) => {
  failures += rules.length;
  for (const rule of rules) console.error(`${where}: ${rule}`);
};
// NUL separators preserve filenames without interpreting them as lines.
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const protectedCount = tracked.filter((file) => /^(raw|scratch|receipts|handoffs)\//.test(file)).length;
if (protectedCount) fail("Git inventory", [`${protectedCount} protected source/scratch paths are tracked`]);
const rows = JSON.parse(await readFile("public/data/daily-burn.json", "utf8"));
for (const [index, row] of rows.entries()) {
  const rules = privateTextFindings(row.evidence);
  if (typeof row.evidence === "string" && row.evidence.length > 180) rules.push("evidence exceeds 180 characters");
  fail(`daily row ${index + 1}`, rules);
}
for (const dir of ["scratch/receipts", "receipts"]) {
  let names;
  try {
    const metadata = await lstat(dir);
    if (!metadata.isDirectory()) throw new Error("receipt directory must be a real directory");
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw new Error("Receipt directory could not be inspected", { cause: error.code });
  }
  for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
    const file = join(dir, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Receipt input must be a regular file");
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
    for (const line of lines) {
      count += 1;
      let receipt;
      try { receipt = JSON.parse(line); }
      catch { // honesty-ok: malformed input is counted and causes gate failure without printing content.
        fail(`receipt ${count}`, ["malformed JSON; privacy unknown"]);
        continue;
      }
      fail(`receipt ${count}`, receiptPrivacyFindings(receipt));
    }
  }
}
console.log(`Receipt privacy: ${rows.length} daily labels, ${count} receipts, ${failures} findings. Pattern checks do not certify semantic anonymity.`);
if (failures) process.exitCode = 1;
