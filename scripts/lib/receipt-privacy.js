// Structural privacy checks supplement, rather than prove, semantic scrubbing.
// Return field positions and rule names only, never matching source values.
const FIELDS = new Set([
  "schema_version", "date", "timezone", "source", "provider", "surface",
  "account_alias", "machine_alias", "origin", "interval", "snapshot_key",
  "dedupe_key", "authority", "models", "tokens", "calls", "fidelity",
  "provenance", "correlation_keys", "capture_method"
]);
const PATTERNS = [
  ["secret-like token", /\b(?:sk-|pplx-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}\b/],
  ["authorization header", /\bBearer\s+\S+/i],
  ["absolute user path", /(?:\/(?:Users|home)\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/i],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["URL", /(?:https?|file):\/\//i],
  ["markup", /<\/?[a-z][^>]*>/i]
];

export function privateTextFindings(value) {
  if (typeof value !== "string") return ["expected text"];
  // Claude transcripts use this literal model marker for synthetic events.
  const text = value.replaceAll("<synthetic>", "synthetic");
  return PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function receiptPrivacyFindings(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return ["expected receipt object"];
  const failures = [];
  const text = (value, where) => {
    for (const rule of privateTextFindings(value)) failures.push(`${where}: ${rule}`);
  };
  // Do not echo untrusted field names: an attacker can put content in a key.
  if (Object.keys(receipt).some((field) => !FIELDS.has(field))) failures.push("unapproved receipt field");
  for (const [field, value] of Object.entries(receipt)) {
    if (!FIELDS.has(field)) continue;
    if (field === "interval") {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some((key) => !["start", "end"].includes(key))) {
        failures.push("interval: expected start/end object");
      } else {
        for (const key of ["start", "end"]) text(value[key], `interval.${key}`);
      }
    } else if (["models", "correlation_keys"].includes(field)) {
      if (!Array.isArray(value)) failures.push(`${field}: expected array`);
      else for (const [index, item] of value.entries()) {
        text(item, `${field}[${index}]`);
        if (field === "correlation_keys" && !/^sha256:[a-f0-9]{64}$/.test(item)) {
          failures.push(`${field}[${index}]: expected SHA-256 identity`);
        }
      }
    } else if (!["schema_version", "tokens", "calls"].includes(field)) {
      text(value, field);
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      failures.push(`${field}: expected nonnegative safe integer`);
    }
  }
  if (typeof receipt.provenance !== "string" || receipt.provenance.length > 500) {
    failures.push("provenance: expected text of at most 500 characters");
  }
  return failures;
}
