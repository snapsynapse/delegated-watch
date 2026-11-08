// The checks that make a dataset publishable as synthetic demonstration data,
// shared by the public-candidate verifier and the served-tree eval so the two
// cannot drift into judging the same rows by different rules.
//
// The rules come from config/public-candidate.json, never from code: the date
// range, the evidence prefix, the row limit, and the reserved identities are
// policy, and a second copy of them here would be a second place to forget.
//
// Returns { problems, triples }. problems is empty when every row passes.
// triples is the (date, source, tokens) set used for reference comparison.

export function syntheticDatasetProblems(rows, inventory, label = "dataset") {
  const problems = [];
  const triples = new Set();
  const origins = new Set(inventory?.reserved_identities?.origins ?? []);
  const policy = inventory?.synthetic_dataset ?? {};

  if (!Array.isArray(rows)) {
    problems.push(`${label} must be an array`);
    return { problems, triples };
  }
  const [from, to] = Array.isArray(policy.date_range) ? policy.date_range : [];
  const prefix = policy.evidence_prefix;
  if (typeof from !== "string" || typeof to !== "string") problems.push("synthetic_dataset.date_range is not set");
  if (typeof prefix !== "string" || !prefix) problems.push("synthetic_dataset.evidence_prefix is not set");
  if (Number.isInteger(policy.max_rows) && rows.length > policy.max_rows) {
    problems.push(`${rows.length} rows exceeds max_rows ${policy.max_rows}`);
  }

  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      problems.push("a row is not an object");
      continue;
    }
    if (typeof row.date !== "string" || !(row.date >= from && row.date <= to)) {
      problems.push(`row date ${JSON.stringify(row.date)} is outside ${from}..${to}`);
    }
    // A missing evidence string is as unclassified as a wrong one: a row the
    // demo serves has to say it was invented.
    if (!(typeof row.evidence === "string" && typeof prefix === "string" && row.evidence.startsWith(prefix))) {
      problems.push(`${row.date} evidence does not begin with "${prefix}"`);
    }
    const sources = row.sources;
    if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
      problems.push(`${row.date} has no sources object`);
      continue;
    }
    for (const [source, entry] of Object.entries(sources)) {
      if (entry === null || typeof entry !== "object") {
        problems.push(`${row.date} source ${source} is not an object`);
        continue;
      }
      if (!["exact", "estimated"].includes(entry.fidelity)) {
        problems.push(`${row.date} source ${source} fidelity ${JSON.stringify(entry.fidelity)} must be exact or estimated`);
      }
      triples.add(`${row.date} ${source} ${entry.tokens}`);
      for (const origin of Object.keys(entry.by_origin ?? {})) {
        if (!origins.has(origin)) problems.push(`${row.date} source ${source} origin "${origin}" is not reserved`);
      }
    }
  }
  return { problems, triples };
}

// Reads a reference dataset into its (date, source, tokens) triples. Every
// failure is a reason string, never a partial set: a reference that cannot be
// read in full cannot prove the absence of an overlap. Row values are never
// included in a reason.
export function referenceTriples(parsed) {
  if (!Array.isArray(parsed)) return { reason: "reference dataset is not an array", triples: null };
  const triples = new Set();
  for (const [index, row] of parsed.entries()) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || typeof row.date !== "string" ||
        row.sources === null || typeof row.sources !== "object" || Array.isArray(row.sources)) {
      return { reason: `reference row ${index + 1} is not a dated row with a sources object`, triples: null };
    }
    for (const [source, entry] of Object.entries(row.sources)) {
      triples.add(`${row.date} ${source} ${entry?.tokens}`);
    }
  }
  return { reason: null, triples };
}
