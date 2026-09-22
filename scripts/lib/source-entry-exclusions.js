import { readFile } from "node:fs/promises";

const CONFIG_URL = new URL("../../config/source-entry-exclusions.json", import.meta.url);

export const loadSourceEntryExclusions = async () => {
  const parsed = JSON.parse(await readFile(CONFIG_URL, "utf8"));
  if (!Array.isArray(parsed.entries)) {
    throw new Error("config/source-entry-exclusions.json entries must be an array");
  }
  return parsed.entries;
};

export const applySourceEntryExclusions = (
  rows,
  exclusions,
  sourceScope = null
) => {
  const rowsByDate = new Map(rows.map((row) => [row.date, row]));
  const seen = new Set();
  const removed = [];

  for (const exclusion of exclusions) {
    const key = `${exclusion.date}/${exclusion.source}`;
    if (seen.has(key)) throw new Error(`Duplicate source-entry exclusion: ${key}`);
    seen.add(key);
    if (sourceScope && !sourceScope.has(exclusion.source)) continue;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(exclusion.date ?? "") ||
      !/^[a-z0-9_]+$/.test(exclusion.source ?? "") ||
      !Number.isInteger(exclusion.tokens) ||
      exclusion.tokens < 0 ||
      !Number.isInteger(exclusion.calls) ||
      exclusion.calls < 0
    ) {
      throw new Error(`Invalid source-entry exclusion: ${key}`);
    }

    const row = rowsByDate.get(exclusion.date);
    const entry = row?.sources?.[exclusion.source];
    if (!entry) continue;
    if (
      entry.tokens !== exclusion.tokens ||
      entry.calls !== exclusion.calls
    ) {
      throw new Error(
        `Source-entry exclusion mismatch for ${key}: expected ` +
          `${exclusion.tokens}/${exclusion.calls}, found ` +
          `${entry.tokens}/${entry.calls ?? "n/a"}`
      );
    }
    delete row.sources[exclusion.source];
    removed.push(key);
  }

  const corrected = rows
    .filter((row) => Object.keys(row.sources).length > 0)
    .map((row) => ({
      ...row,
      total: Object.values(row.sources).reduce(
        (sum, entry) => sum + entry.tokens,
        0
      )
    }));
  return { rows: corrected, removed };
};
