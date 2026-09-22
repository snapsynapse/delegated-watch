// Validate public/data/daily-burn.json against the dataset contract: calendar
// dates, sorted and unique, every source entry with a declared fidelity, totals
// that cross-foot, drivers from the reviewed vocabulary, and no row for a day
// that has not fully elapsed. Exits nonzero on the first failing dataset.
//
// Usage:
//   node scripts/validate-data.js
import { access, readFile } from "node:fs/promises";
import { assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
import { validateDataset } from "./lib/dataset-validation.js";
import { calendarDay } from "./lib/import-policy.js";
import { profile } from "./lib/profile.js";

await assertNoPendingAcceptance();
const { timezone, window_start: windowStart } = await profile();
const rows = JSON.parse(await readFile("public/data/daily-burn.json", "utf8"));
const errors = validateDataset(rows, {
  timezone,
  windowStart,
  today: calendarDay(timezone),
  requireReviewed: false,
  allowSample: false
});
rows.forEach((row, index) => {
  if (!row || typeof row !== "object" || Array.isArray(row) || !Object.hasOwn(row, "evidence")) {
    errors.push(`row ${index + 1} missing evidence`);
  }
});

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${rows.length} daily burn rows.`);

try {
  await access("public/data/github-summary.json");
  const githubSummary = JSON.parse(await readFile("public/data/github-summary.json", "utf8"));
  const githubErrors = [];
  ["username", "window", "range_start", "range_end", "contributions", "as_of", "source", "fidelity"].forEach((key) => {
    if (!(key in githubSummary)) githubErrors.push(`github summary missing ${key}`);
  });
  if (!Number.isInteger(githubSummary.contributions) || githubSummary.contributions < 0) {
    githubErrors.push("github summary contributions must be a nonnegative integer");
  }
  if (githubSummary.fidelity !== "exact_lookup") githubErrors.push("github summary fidelity must be exact_lookup");
  if (githubErrors.length) {
    console.error(githubErrors.join("\n"));
    process.exit(1);
  }
  console.log(`Validated GitHub summary for ${githubSummary.username}.`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
