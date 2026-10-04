import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  chmod,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isCalendarDate } from "./dataset-validation.js";
import {
  aggregateTokenComponents,
  authorityRankOf,
  normalizeReceipt,
  normalizeTokenComponents,
  reconcileTokenComponents,
  sameAuthorityScope,
  snapshotKeyOf,
  validateTokenComponents
} from "./receipt-schema.js";
import { recordPaths } from "./record-paths.js";

export const ACCEPTED_DATA_PATH = recordPaths().dataset;
export const ACCEPTED_MANIFEST_PATH = recordPaths().manifest;
export const ACCEPTANCE_LOCK_PATH = "scratch/accepted-evidence.lock";
export const ACCEPTANCE_JOURNAL_PATH =
  "scratch/accepted-evidence-transaction.json";
export const RECOVERY_LOCK_PATH = "scratch/accepted-evidence-recovery.lock";

const SOURCE = /^[a-z0-9_]+$/;
const SCOPE_FIELDS = [
  "provider",
  "surface",
  "account_alias",
  "origin",
  "machine_alias"
];

const NOTE =
  "Persistent identity ledger for evidence accepted into public/data/daily-burn.json. " +
  "Accepted identities survive disappearance of raw receipts. Entries inherited from " +
  "the former raw-receipt manifest are labelled legacy-unverified until a current " +
  "dataset-matched acceptance proves them.";

const DEDUPE_LEVELS = {
  "request-level":
    "correlation_keys identify individual requests; partial overlap fails closed.",
  "day-level":
    "snapshot_key identifies a stable source, scope, and day snapshot.",
  none: "no durable identity is available, so a future import cannot be verified clean."
};

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const byteRecord = (text, present = true) => ({
  present,
  bytes: Buffer.byteLength(text, "utf8"),
  sha256: sha256(text),
  content_base64: Buffer.from(text, "utf8").toString("base64")
});

const textOfRecord = (record, label) => {
  if (
    !record ||
    !Number.isInteger(record.bytes) ||
    record.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(record.sha256 ?? "") ||
    typeof record.content_base64 !== "string" ||
    typeof record.present !== "boolean"
  ) {
    throw new Error(`Invalid ${label} byte record in acceptance journal`);
  }
  const text = Buffer.from(record.content_base64, "base64").toString("utf8");
  if (
    Buffer.byteLength(text, "utf8") !== record.bytes ||
    sha256(text) !== record.sha256
  ) {
    throw new Error(`${label} byte record does not match its size and hash`);
  }
  return text;
};

const pathAt = (root, relativePath) => join(root, relativePath);

const exists = async (path) => {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
};

const directoryExists = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const atomicWriteText = async (path, text, finalMode = 0o600) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    if (finalMode !== 0o600) await chmod(temporary, finalMode);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Nothing to clean when creation or rename did not leave a temp file.
    }
    throw error;
  }
};

const readJsonText = async (path, label) => {
  const text = await readFile(path, "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON`);
  }
};

const readOptionalManifest = async (path) => {
  try {
    const current = await readJsonText(path, ACCEPTED_MANIFEST_PATH);
    return { ...current, present: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { text: "", value: emptyManifest(), present: false };
  }
};

const readOptionalText = async (path) => {
  try {
    return { present: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, text: "" };
    throw error;
  }
};

const stableKeys = (value) =>
  [...new Set(Array.isArray(value) ? value : [])].sort();

const receiptScope = (receipt) =>
  Object.fromEntries(SCOPE_FIELDS.map((field) => [field, receipt[field] ?? null]));

const sameScopeDay = (left, right) => {
  if (left.date !== right.date || left.source !== right.source) return false;
  return SCOPE_FIELDS.every((field) => {
    const leftValue = left[field] ?? null;
    const rightValue = right[field] ?? null;
    return leftValue === null || rightValue === null || leftValue === rightValue;
  });
};

const equalKeySets = (left, right) => {
  const a = stableKeys(left);
  const b = stableKeys(right);
  return a.length === b.length && a.every((key, index) => key === b[index]);
};

const intersection = (left, right) => {
  const rightSet = new Set(right);
  return stableKeys(left).filter((key) => rightSet.has(key));
};

const callsOf = (entry) =>
  Number.isInteger(entry.calls) ? entry.calls : null;

const counterRelation = (existing, incoming) => {
  const oldCalls = callsOf(existing);
  const newCalls = callsOf(incoming);
  const tokenDirection = Math.sign(incoming.tokens - existing.tokens);
  const callDirection =
    oldCalls === null || newCalls === null ? 0 : Math.sign(newCalls - oldCalls);
  if (tokenDirection >= 0 && callDirection >= 0) return "forward";
  if (tokenDirection <= 0 && callDirection <= 0) return "replay";
  return "crossing";
};

const normalizedEntry = (entry, inherited = false) => {
  const normalized = normalizeReceipt({ ...entry });
  return {
    date: normalized.date,
    source: normalized.source,
    provider: normalized.provider ?? null,
    surface: normalized.surface ?? null,
    account_alias: normalized.account_alias ?? null,
    origin: normalized.origin ?? null,
    machine_alias: normalized.machine_alias ?? null,
    snapshot_key: snapshotKeyOf(normalized),
    authority: normalized.authority ?? null,
    tokens: normalized.tokens,
    calls: Number.isInteger(normalized.calls) ? normalized.calls : null,
    ...(normalized.token_components
      ? { token_components: normalizeTokenComponents(normalized.token_components) }
      : {}),
    correlation_keys: stableKeys(normalized.correlation_keys),
    acceptance:
      entry.acceptance === "accepted" ? "accepted" : "legacy-unverified",
    ...(entry.acceptance_basis ? { acceptance_basis: entry.acceptance_basis } : {}),
    ...(Array.isArray(entry.superseded_snapshots)
      ? { superseded_snapshots: entry.superseded_snapshots }
      : {}),
    ...(entry.correction ? { correction: entry.correction } : {}),
    ...(entry.disposition ? { disposition: entry.disposition } : {}),
    ...(entry.superseded_by ? { superseded_by: entry.superseded_by } : {}),
    ...(inherited && !entry.acceptance
      ? { legacy_note: "Inherited from the pre-ledger manifest; acceptance was not recorded." }
      : entry.legacy_note
        ? { legacy_note: entry.legacy_note }
        : {})
  };
};

const entryFromReceipt = (receipt) => {
  const normalized = normalizeReceipt({ ...receipt });
  return normalizedEntry(
    {
      ...normalized,
      snapshot_key: snapshotKeyOf(normalized),
      acceptance: "accepted",
      acceptance_basis: "matched-final-dataset"
    },
    false
  );
};

// The six named keys happen to separate every entry in the current record, but
// nothing guarantees that: two entries alike on all six would compare equal and
// Array.sort would keep whatever order the caller happened to build, making the
// committed file depend on receipt iteration order. The canonical-form
// tiebreaker makes the order total by construction rather than by luck.
export const compareEntries = (a, b) =>
  String(a.date).localeCompare(String(b.date)) ||
  String(a.source).localeCompare(String(b.source)) ||
  String(a.origin).localeCompare(String(b.origin)) ||
  String(a.machine_alias).localeCompare(String(b.machine_alias)) ||
  String(a.snapshot_key).localeCompare(String(b.snapshot_key)) ||
  String(a.acceptance).localeCompare(String(b.acceptance)) ||
  canonicalForm(a).localeCompare(canonicalForm(b));

const canonicalForm = (entry) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(entry).sort(([x], [y]) => x.localeCompare(y)))
  );

const sortEntries = (entries) => entries.sort(compareEntries);

export function summarizeCoverage(entries) {
  const bySource = new Map();
  for (const entry of entries) {
    if (!isCalendarDate(entry.date) || !SOURCE.test(entry.source ?? "")) {
      throw new Error("Manifest entry has invalid date or source");
    }
    if (!Number.isSafeInteger(entry.tokens) || entry.tokens < 0) {
      throw new Error(`${entry.date}/${entry.source} has invalid tokens`);
    }
    const summary = bySource.get(entry.source) ?? {
      receipts: 0,
      active_receipts: 0,
      tokens: 0,
      identified_requests: 0,
      with_snapshot_key: 0,
      accepted_receipts: 0,
      legacy_unverified_receipts: 0,
      superseded_history_receipts: 0,
      excluded_identity_receipts: 0,
      first: entry.date,
      last: entry.date,
      _identified_requests: new Set()
    };
    summary.receipts += 1;
    if (isActiveEntry(entry)) {
      summary.active_receipts += 1;
      summary.tokens += entry.tokens;
      for (const key of stableKeys(entry.correlation_keys)) {
        summary._identified_requests.add(key);
      }
      if (entry.snapshot_key) summary.with_snapshot_key += 1;
      if (entry.acceptance === "accepted") summary.accepted_receipts += 1;
      else summary.legacy_unverified_receipts += 1;
    }
    if (entry.disposition === "superseded") summary.superseded_history_receipts += 1;
    if (entry.disposition === "excluded") summary.excluded_identity_receipts += 1;
    if (entry.date < summary.first) summary.first = entry.date;
    if (entry.date > summary.last) summary.last = entry.date;
    bySource.set(entry.source, summary);
  }
  return Object.fromEntries(
    [...bySource]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, summary]) => {
        const { _identified_requests: identities, ...publicSummary } = summary;
        return [
          source,
          {
            ...publicSummary,
            identified_requests: identities.size,
            dedupe: identities.size
              ? "request-level"
              : summary.active_receipts > 0 &&
                  summary.with_snapshot_key === summary.active_receipts
                ? "day-level"
                : "none"
          }
        ];
      })
  );
}

const summarizeLegacyCoverage = (entries) => {
  const bySource = new Map();
  for (const entry of entries) {
    const summary = bySource.get(entry.source) ?? {
      receipts: 0,
      tokens: 0,
      identified_requests: 0,
      with_snapshot_key: 0,
      accepted_receipts: 0,
      legacy_unverified_receipts: 0,
      excluded_identity_receipts: 0,
      first: entry.date,
      last: entry.date
    };
    summary.receipts += 1;
    summary.tokens += entry.tokens;
    summary.identified_requests += stableKeys(entry.correlation_keys).length;
    if (entry.snapshot_key) summary.with_snapshot_key += 1;
    if (entry.acceptance === "accepted") summary.accepted_receipts += 1;
    else summary.legacy_unverified_receipts += 1;
    if (entry.disposition === "excluded") summary.excluded_identity_receipts += 1;
    if (entry.date < summary.first) summary.first = entry.date;
    if (entry.date > summary.last) summary.last = entry.date;
    bySource.set(entry.source, summary);
  }
  return Object.fromEntries(
    [...bySource]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, summary]) => [
        source,
        {
          ...summary,
          dedupe: summary.identified_requests
            ? "request-level"
            : summary.with_snapshot_key === summary.receipts
              ? "day-level"
              : "none"
        }
      ])
  );
};

export function validateAcceptedManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Evidence manifest must be an object");
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Evidence manifest entries must be an array");
  }
  for (const entry of manifest.entries) {
    if (!Object.hasOwn(entry, "token_components")) continue;
    const componentErrors = validateTokenComponents(
      entry.token_components,
      `${entry.date}/${entry.source} token_components`
    );
    if (componentErrors.length) throw new Error(componentErrors.join("\n"));
  }
  const entries = manifest.entries.map((entry) => normalizedEntry(entry, true));
  const coverage = summarizeCoverage(entries);
  const legacyCoverage = summarizeLegacyCoverage(entries);
  for (const field of [
    "receipts",
    "identified_requests",
    "malformed_receipt_lines"
  ]) {
    if (!Number.isInteger(manifest[field]) || manifest[field] < 0) {
      throw new Error(`Evidence manifest ${field} must be a nonnegative integer`);
    }
  }
  if (!manifest.coverage || typeof manifest.coverage !== "object") {
    throw new Error("Evidence manifest coverage must be an object");
  }
  if (manifest.ledger_version === 2) {
    const active = entries.filter(isActiveEntry);
    const identified = new Set(
      active.flatMap((entry) => entry.correlation_keys)
    ).size;
    const accepted = active.filter((entry) => entry.acceptance === "accepted").length;
    const legacy = active.length - accepted;
    const superseded = entries.filter(
      (entry) => entry.disposition === "superseded"
    ).length;
    const legacyIdentified = entries.reduce(
      (sum, entry) => sum + entry.correlation_keys.length,
      0
    );
    const legacyAccepted = entries.filter(
      (entry) => entry.acceptance === "accepted"
    ).length;
    if (manifest.receipts !== entries.length) {
      throw new Error("Evidence manifest receipts does not match entries length");
    }
    const activeSummary = isDeepStrictEqual(manifest.coverage, coverage);
    const legacySummary = isDeepStrictEqual(manifest.coverage, legacyCoverage);
    const activeSummaryFormat =
      Object.hasOwn(manifest.ledger ?? {}, "superseded_history_receipts") ||
      Object.values(manifest.coverage).some((summary) =>
        Object.hasOwn(summary, "active_receipts")
      );
    if (activeSummaryFormat ? !activeSummary : !legacySummary) {
      throw new Error("Evidence manifest coverage does not match entries");
    }
    const summaryMatches = activeSummaryFormat
      ? manifest.identified_requests === identified &&
        manifest.ledger?.accepted_receipts === accepted &&
        manifest.ledger?.legacy_unverified_receipts === legacy &&
        manifest.ledger?.superseded_history_receipts === superseded
      : manifest.identified_requests === legacyIdentified &&
        manifest.ledger?.accepted_receipts === legacyAccepted &&
        manifest.ledger?.legacy_unverified_receipts === entries.length - legacyAccepted &&
        manifest.ledger?.superseded_history_receipts === undefined;
    if (!summaryMatches) {
      throw new Error("Evidence manifest ledger summary does not match entries");
    }
    if (!Array.isArray(manifest.ledger?.corrections)) {
      throw new Error("Evidence manifest ledger summary does not match entries");
    }
  }
  return { entries, coverage };
}

const emptyManifest = () => ({
  note: NOTE,
  dedupe_levels: DEDUPE_LEVELS,
  ledger_version: 2,
  receipts: 0,
  identified_requests: 0,
  malformed_receipt_lines: 0,
  coverage: {},
  ledger: {
    accepted_receipts: 0,
    legacy_unverified_receipts: 0,
    superseded_history_receipts: 0,
    corrections: []
  },
  entries: []
});

const manifestFromEntries = (previous, entries, correction = null) => {
  sortEntries(entries);
  const coverage = summarizeCoverage(entries);
  const corrections = Array.isArray(previous.ledger?.corrections)
    ? [...previous.ledger.corrections]
    : [];
  if (correction) {
    corrections.push({
      confirmed: true,
      reason: correction.reason,
      recorded_at: new Date().toISOString()
    });
  }
  const active = entries.filter(isActiveEntry);
  const accepted = active.filter((entry) => entry.acceptance === "accepted").length;
  const identified = new Set(
    active.flatMap((entry) => entry.correlation_keys)
  ).size;
  const superseded = entries.filter(
    (entry) => entry.disposition === "superseded"
  ).length;
  return {
    note: NOTE,
    dedupe_levels: DEDUPE_LEVELS,
    ledger_version: 2,
    receipts: entries.length,
    identified_requests: identified,
    malformed_receipt_lines: previous.malformed_receipt_lines ?? 0,
    coverage,
    ledger: {
      accepted_receipts: accepted,
      legacy_unverified_receipts: active.length - accepted,
      superseded_history_receipts: superseded,
      corrections
    },
    entries
  };
};

const priorVersions = (entry) =>
  Array.isArray(entry.superseded_snapshots) ? entry.superseded_snapshots : [];

const exactVersion = (version, incoming) =>
  version.tokens === incoming.tokens &&
  callsOf(version) === callsOf(incoming) &&
  equalKeySets(version.correlation_keys, incoming.correlation_keys) &&
  isDeepStrictEqual(
    normalizeTokenComponents(version.token_components),
    normalizeTokenComponents(incoming.token_components)
  );

const equivalentVersionCounters = (left, right) =>
  left.tokens === right.tokens &&
  callsOf(left) === callsOf(right) &&
  equalKeySets(left.correlation_keys, right.correlation_keys);

const withReconciledTokenComponents = (left, right, where) => {
  if (!equivalentVersionCounters(left, right)) return right;
  const reconciled = reconcileTokenComponents(
    left.token_components,
    right.token_components,
    where
  );
  if (reconciled.errors.length) throw new Error(reconciled.errors.join("\n"));
  const merged = { ...right };
  if (reconciled.token_components) {
    merged.token_components = reconciled.token_components;
  } else {
    delete merged.token_components;
  }
  return merged;
};

const snapshotVersion = (entry) => ({
  tokens: entry.tokens,
  calls: callsOf(entry),
  correlation_keys: stableKeys(entry.correlation_keys),
  ...(entry.token_components
    ? { token_components: normalizeTokenComponents(entry.token_components) }
    : {})
});

const addAcceptedEntry = (entries, incoming, correction) => {
  const accepted = entries.filter(
    (entry) => entry.acceptance === "accepted" && isActiveEntry(entry)
  );
  const legacy = entries.filter(
    (entry) => entry.acceptance !== "accepted" && isActiveEntry(entry)
  );
  const snapshot = incoming.snapshot_key;

  if (!snapshot && !incoming.correlation_keys.length) {
    const prior = accepted.find((entry) =>
      !entry.snapshot_key &&
      !entry.correlation_keys.length &&
      sameScopeDay(entry, incoming)
    );
    if (prior) {
      if (exactVersion(prior, incoming)) return { kind: "replay", entry: prior };
      if (!correction) {
        throw new Error(
          `Identity-free receipt for ${incoming.date}/${incoming.source} cannot be ` +
            "distinguished from previously accepted evidence"
        );
      }
      // Identity-free counters carry no request identities, so nothing in the
      // receipt can show whether a changed figure is the same measurement
      // revised or a different one. Only a recorded human verdict can settle
      // that, and it supersedes rather than overwrites: the prior counters are
      // retained so a later flip back is recognised as a replay of a version
      // already accepted.
      const superseded = [
        ...priorVersions(prior),
        snapshotVersion(prior)
      ];
      Object.assign(prior, incoming, {
        acceptance: "accepted",
        acceptance_basis: "identity-free-correction-after-review",
        superseded_snapshots: superseded,
        correction: { confirmed: true, reason: correction.reason }
      });
      return { kind: "updated", entry: prior };
    }
    const inherited = legacy.find((entry) =>
      !entry.snapshot_key &&
      !entry.correlation_keys.length &&
      sameScopeDay(entry, incoming) &&
      exactVersion(entry, incoming)
    );
    if (inherited) {
      Object.assign(inherited, incoming, {
        acceptance: "accepted",
        acceptance_basis: "matched-final-dataset-after-legacy-migration",
        legacy_note:
          "Identity-free legacy counters matched a current final dataset bucket; future changes remain uncheckable."
      });
      return { kind: "promoted", entry: inherited };
    }
  }

  if (snapshot) {
    const existing = accepted.find((entry) => entry.snapshot_key === snapshot);
    if (existing) {
      if (!sameScopeDay(existing, incoming)) {
        throw new Error(
          `Historic snapshot ${snapshot} overlaps a different scope or day`
        );
      }
      incoming = withReconciledTokenComponents(
        existing,
        incoming,
        `${snapshot} token_components`
      );
      for (const other of accepted) {
        if (other === existing) continue;
        const overlap = intersection(
          other.correlation_keys,
          incoming.correlation_keys
        );
        if (!overlap.length) continue;
        if (
          !sameScopeDay(other, incoming) ||
          !equalKeySets(other.correlation_keys, incoming.correlation_keys)
        ) {
          throw new Error(
            `Snapshot ${snapshot} has request identities belonging to another accepted snapshot`
          );
        }
      }
      if (
        equivalentVersionCounters(existing, incoming) &&
        !exactVersion(existing, incoming)
      ) {
        const enriched = normalizedEntry({
          ...existing,
          ...incoming,
          acceptance: "accepted",
          acceptance_basis: existing.acceptance_basis ?? "matched-final-dataset"
        });
        entries[entries.indexOf(existing)] = enriched;
        return { kind: "updated", entry: enriched };
      }
      if (
        !correction &&
        (
          exactVersion(existing, incoming) ||
          priorVersions(existing).some((version) => exactVersion(version, incoming))
        )
      ) {
        return { kind: "replay", entry: existing };
      }
      const relation = counterRelation(existing, incoming);
      if (relation === "crossing" && !correction) {
        throw new Error(`Snapshot ${snapshot} has crossing token/call history`);
      }
      if (relation === "replay" && !correction) {
        return { kind: "replay", entry: existing };
      }
      const incomingKeys = stableKeys(incoming.correlation_keys);
      const oldKeys = stableKeys(existing.correlation_keys);
      const oldOnly = oldKeys.filter((key) => !incomingKeys.includes(key));
      if (oldOnly.length && !correction) {
        throw new Error(
          `Snapshot ${snapshot} update omits ${oldOnly.length} accepted request identities`
        );
      }
      const superseded = [
        ...priorVersions(existing),
        snapshotVersion(existing)
      ];
      Object.assign(existing, incoming, {
        correlation_keys: stableKeys([...oldKeys, ...incomingKeys]),
        acceptance: "accepted",
        acceptance_basis: "matched-final-dataset",
        superseded_snapshots: superseded,
        ...(correction
          ? { correction: { confirmed: true, reason: correction.reason } }
          : {})
      });
      return { kind: "updated", entry: existing };
    }
  }

  for (const existing of accepted) {
    const overlap = intersection(
      existing.correlation_keys,
      incoming.correlation_keys
    );
    if (!overlap.length) continue;
    if (
      equalKeySets(existing.correlation_keys, incoming.correlation_keys) &&
      sameAuthorityScope(existing, incoming)
    ) {
      const existingRank = authorityRankOf(existing);
      const incomingRank = authorityRankOf(incoming);
      if (existingRank > incomingRank) {
        return { kind: "replay", entry: existing };
      }
      if (existingRank === incomingRank) {
        if (sameScopeDay(existing, incoming) && exactVersion(existing, incoming)) {
          return { kind: "replay", entry: existing };
        }
        throw new Error(
          `Equal-authority historic request overlap conflicts for ${incoming.date}/${incoming.source}`
        );
      }
      existing.disposition = "superseded";
      existing.superseded_by = {
        source: incoming.source,
        snapshot_key: incoming.snapshot_key,
        authority: incoming.authority
      };
      entries.push(incoming);
      return { kind: "added", entry: incoming, superseded: existing };
    }
    if (!sameScopeDay(existing, incoming)) {
      throw new Error(
        `Historic request overlap crosses scope or day for ${incoming.date}/${incoming.source}`
      );
    }
    throw new Error(
      `Partial historic request overlap for ${incoming.date}/${incoming.source}`
    );
  }

  for (const existing of legacy) {
    const sameSnapshot =
      snapshot && existing.snapshot_key && snapshot === existing.snapshot_key;
    const overlap = intersection(
      existing.correlation_keys,
      incoming.correlation_keys
    );
    if (!sameSnapshot && !overlap.length) continue;
    if (!sameScopeDay(existing, incoming)) {
      throw new Error(
        `Unverified legacy identity overlaps a different scope or day; migrate it explicitly`
      );
    }
    const legacyKeys = stableKeys(existing.correlation_keys);
    const incomingKeys = stableKeys(incoming.correlation_keys);
    const keysCovered = legacyKeys.every((key) => incomingKeys.includes(key));
    const relation = counterRelation(existing, incoming);
    if (!keysCovered || relation === "crossing" || (relation === "replay" && !exactVersion(existing, incoming))) {
      if (!correction) {
        throw new Error(
          `Unverified legacy identity for ${incoming.date}/${incoming.source} is ambiguous; ` +
            `an explicit confirmed correction is required`
        );
      }
    }
    Object.assign(existing, incoming, {
      correlation_keys: stableKeys([...legacyKeys, ...incomingKeys]),
      acceptance: "accepted",
      acceptance_basis: "matched-final-dataset-after-legacy-migration",
      legacy_note: "Legacy identity promoted only after a current receipt matched the final dataset.",
      ...(correction
        ? { correction: { confirmed: true, reason: correction.reason } }
        : {})
    });
    return { kind: "promoted", entry: existing };
  }

  entries.push(incoming);
  return { kind: "added", entry: incoming };
};

const rowEntries = (rows) => {
  if (!Array.isArray(rows)) throw new Error("Accepted dataset must be an array");
  const result = new Map();
  for (const row of rows) {
    if (!isCalendarDate(row?.date) || !row.sources || typeof row.sources !== "object") {
      throw new Error("Accepted dataset row has invalid date or sources");
    }
    for (const [source, entry] of Object.entries(row.sources)) {
      result.set(`${row.date}/${source}`, entry);
    }
  }
  return result;
};

const isActiveEntry = (entry) =>
  !["excluded", "corrected-out", "superseded"].includes(entry.disposition);

const aggregateCalls = (entries) => ({
  present: entries.some((entry) => Number.isInteger(entry.calls)),
  value: entries.reduce(
    (sum, entry) => sum + (Number.isInteger(entry.calls) ? entry.calls : 0),
    0
  )
});

const assertLedgerMatchesSourceEntry = (key, sourceEntry, entries) => {
  const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const calls = aggregateCalls(entries);
  if (
    tokens !== sourceEntry.tokens ||
    (calls.present ? calls.value !== sourceEntry.calls : Number.isInteger(sourceEntry.calls)) ||
    !isDeepStrictEqual(
      aggregateTokenComponents(entries),
      normalizeTokenComponents(sourceEntry.token_components)
    )
  ) {
    throw new Error(
      `Accepted ledger cannot atomically replace ${key}: active evidence does not match the dataset`
    );
  }
  if (sourceEntry.by_origin) {
    if (entries.some((entry) => !entry.origin)) {
      throw new Error(
        `Accepted ledger cannot atomically replace ${key}: origin evidence is incomplete`
      );
    }
    const origins = new Map();
    for (const entry of entries) {
      origins.set(entry.origin, (origins.get(entry.origin) ?? 0) + entry.tokens);
    }
    if (!isDeepStrictEqual(Object.fromEntries([...origins].sort()), sourceEntry.by_origin)) {
      throw new Error(
        `Accepted ledger cannot atomically replace ${key}: origin evidence does not match the dataset`
      );
    }
  }
};

const rebuildSourceEntry = (current, entries) => {
  const rebuilt = { ...current };
  rebuilt.tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  const calls = aggregateCalls(entries);
  if (calls.present) rebuilt.calls = calls.value;
  else delete rebuilt.calls;
  const components = aggregateTokenComponents(entries);
  if (components) rebuilt.token_components = components;
  else delete rebuilt.token_components;
  if (entries.every((entry) => entry.origin)) {
    const origins = new Map();
    for (const entry of entries) {
      origins.set(entry.origin, (origins.get(entry.origin) ?? 0) + entry.tokens);
    }
    rebuilt.by_origin = Object.fromEntries([...origins].sort());
  } else {
    delete rebuilt.by_origin;
  }
  return rebuilt;
};

export async function planPersistedAuthorityTransitions({
  rows,
  receipts,
  root = process.cwd()
}) {
  const currentManifest = await readOptionalManifest(
    pathAt(root, ACCEPTED_MANIFEST_PATH)
  );
  const { entries } = validateAcceptedManifest(currentManifest.value);
  const active = entries.filter(isActiveEntry);
  const retiring = new Set();
  const kept = [];

  for (const raw of receipts) {
    let candidate = raw;
    let incoming = entryFromReceipt(candidate);
    if (incoming.snapshot_key) {
      const sameSnapshots = active.filter(
        (entry) => entry.snapshot_key === incoming.snapshot_key
      );
      if (sameSnapshots.length > 1) {
        throw new Error(`Historic snapshot ${incoming.snapshot_key} has multiple active entries`);
      }
      const [sameSnapshot] = sameSnapshots;
      if (sameSnapshot && sameScopeDay(sameSnapshot, incoming)) {
        const merged = withReconciledTokenComponents(
          sameSnapshot,
          incoming,
          `${incoming.snapshot_key} token_components`
        );
        candidate = { ...raw };
        if (merged.token_components) {
          candidate.token_components = merged.token_components;
        } else {
          delete candidate.token_components;
        }
        incoming = entryFromReceipt(candidate);
      }
    }
    const keys = incoming.correlation_keys;
    if (!keys.length) {
      kept.push(candidate);
      continue;
    }
    const hits = active.filter((entry) => {
      if (entry.snapshot_key && entry.snapshot_key === incoming.snapshot_key) return false;
      return intersection(entry.correlation_keys, keys).length > 0;
    });
    if (!hits.length) {
      kept.push(candidate);
      continue;
    }
    if (hits.length > 1) {
      throw new Error(
        `Historic request overlap for ${incoming.date}/${incoming.source} matches multiple active entries`
      );
    }
    const [existing] = hits;
    if (existing.acceptance !== "accepted") {
      throw new Error(
        `Unverified legacy identity overlaps ${incoming.date}/${incoming.source}; migrate it explicitly`
      );
    }
    if (!equalKeySets(existing.correlation_keys, keys)) {
      throw new Error(`Partial historic request overlap for ${incoming.date}/${incoming.source}`);
    }
    if (!sameAuthorityScope(existing, incoming)) {
      throw new Error(
        `Historic request overlap crosses accounting scope or day for ${incoming.date}/${incoming.source}`
      );
    }
    const existingRank = authorityRankOf(existing);
    const incomingRank = authorityRankOf(incoming);
    if (existingRank > incomingRank) continue;
    if (existingRank === incomingRank) {
      if (sameScopeDay(existing, incoming)) kept.push(candidate);
      else {
        throw new Error(
          `Equal-authority historic request overlap crosses source scope for ${incoming.date}/${incoming.source}`
        );
      }
      continue;
    }
    retiring.add(existing);
    kept.push(candidate);
  }

  if (!retiring.size) {
    return { rows, receipts: kept, supersededSources: [] };
  }

  const adjusted = structuredClone(rows);
  const rowsByDate = new Map(adjusted.map((row) => [row.date, row]));
  const affected = new Set(
    [...retiring].map((entry) => `${entry.date}/${entry.source}`)
  );
  for (const key of affected) {
    const slash = key.indexOf("/");
    const date = key.slice(0, slash);
    const source = key.slice(slash + 1);
    const row = rowsByDate.get(date);
    const sourceEntry = row?.sources?.[source];
    if (!sourceEntry) {
      throw new Error(`Accepted ledger cannot atomically replace ${key}: dataset entry is absent`);
    }
    const sourceEntries = active.filter(
      (entry) => entry.date === date && entry.source === source
    );
    assertLedgerMatchesSourceEntry(key, sourceEntry, sourceEntries);
    const remaining = sourceEntries.filter((entry) => !retiring.has(entry));
    if (remaining.length) row.sources[source] = rebuildSourceEntry(sourceEntry, remaining);
    else delete row.sources[source];
  }
  return {
    rows: adjusted,
    receipts: kept,
    supersededSources: [...affected].sort()
  };
};

const acceptedReceiptBuckets = (rows, receipts, excludedSources) => {
  const finalEntries = rowEntries(rows);
  const excluded = new Set(
    excludedSources.map((value) =>
      typeof value === "string" ? value : `${value.date}/${value.source}`
    )
  );
  const buckets = new Map();
  const skipped = [];
  for (const raw of receipts) {
    const receipt = normalizeReceipt({ ...raw });
    const key = `${receipt.date}/${receipt.source}`;
    if (excluded.has(key)) {
      skipped.push({ key, reason: "excluded" });
      continue;
    }
    if (!finalEntries.has(key)) {
      skipped.push({ key, reason: "not-in-final-dataset" });
      continue;
    }
    const bucket = buckets.get(key) ?? [];
    bucket.push(receipt);
    buckets.set(key, bucket);
  }

  const accepted = [];
  for (const [key, bucket] of buckets) {
    const finalEntry = finalEntries.get(key);
    const tokens = bucket.reduce((sum, receipt) => sum + receipt.tokens, 0);
    const hasCalls = bucket.some((receipt) => Number.isInteger(receipt.calls));
    const calls = bucket.reduce(
      (sum, receipt) => sum + (Number.isInteger(receipt.calls) ? receipt.calls : 0),
      0
    );
    if (
      finalEntry.tokens !== tokens ||
      (hasCalls && finalEntry.calls !== calls) ||
      (!hasCalls && Number.isInteger(finalEntry.calls)) ||
      !isDeepStrictEqual(
        normalizeTokenComponents(finalEntry.token_components),
        aggregateTokenComponents(bucket)
      )
    ) {
      throw new Error(
        `Accepted receipt bucket ${key} does not match final dataset counters: ` +
          `receipts ${tokens}/${hasCalls ? calls : "n/a"}, dataset ` +
          `${finalEntry.tokens}/${finalEntry.calls ?? "n/a"}`
      );
    }
    const ledgerReceipts = bucket.filter(
      (receipt) => snapshotKeyOf(receipt) || stableKeys(receipt.correlation_keys).length
    );
    const identityFree = new Map();
    for (const receipt of bucket.filter(
      (candidate) =>
        !snapshotKeyOf(candidate) && !stableKeys(candidate.correlation_keys).length
    )) {
      const scope = JSON.stringify(receiptScope(receipt));
      const combined = identityFree.get(scope) ?? {
        ...receipt,
        tokens: 0,
        calls: 0,
        _hasCalls: false,
        _componentReceipts: [],
        correlation_keys: []
      };
      combined.tokens += receipt.tokens;
      if (Number.isInteger(receipt.calls)) {
        combined.calls += receipt.calls;
        combined._hasCalls = true;
      }
      if (receipt.fidelity === "estimated") combined.fidelity = "estimated";
      combined._componentReceipts.push(receipt);
      identityFree.set(scope, combined);
    }
    for (const combined of identityFree.values()) {
      if (!combined._hasCalls) delete combined.calls;
      const tokenComponents = aggregateTokenComponents(combined._componentReceipts);
      if (tokenComponents) combined.token_components = tokenComponents;
      delete combined._hasCalls;
      delete combined._componentReceipts;
      ledgerReceipts.push(combined);
    }
    buckets.set(key, ledgerReceipts);
    accepted.push(...ledgerReceipts);
  }
  return { accepted, buckets, finalEntries, skipped };
};

export function checkEvidenceOverlap(manifest, inputReceipts) {
  const { entries } = validateAcceptedManifest(manifest);
  const result = {
    receipts: inputReceipts.length,
    identified_requests: 0,
    already_counted_requests: 0,
    snapshot_hits: 0,
    new_requests: 0,
    new_snapshots: 0,
    evolved_snapshots: 0,
    replayed_older_snapshots: 0,
    replay_receipts: 0,
    legacy_unverified_hits: 0,
    uncheckable: [],
    snapshot_variants: [],
    conflicts: []
  };
  for (const raw of inputReceipts) {
    const incoming = entryFromReceipt(raw);
    const keys = incoming.correlation_keys;
    result.identified_requests += keys.length;
    if (!keys.length && !incoming.snapshot_key) {
      result.uncheckable.push(`${incoming.date}/${incoming.source}`);
      continue;
    }
    const hits = entries.filter((entry) => {
      const snapshotHit =
        incoming.snapshot_key && entry.snapshot_key === incoming.snapshot_key;
      return snapshotHit || intersection(entry.correlation_keys, keys).length > 0;
    });
    if (!hits.length) {
      result.new_requests += keys.length;
      if (incoming.snapshot_key) result.new_snapshots += 1;
      continue;
    }
    let counted = false;
    for (const hit of hits) {
      const overlap = intersection(hit.correlation_keys, keys);
      result.already_counted_requests += overlap.length;
      if (incoming.snapshot_key && hit.snapshot_key === incoming.snapshot_key) {
        result.snapshot_hits += 1;
        if (!sameScopeDay(hit, incoming)) {
          result.conflicts.push(
            `${incoming.date}/${incoming.source} overlaps a different scope or day`
          );
          continue;
        }
        if (exactVersion(hit, incoming)) {
          if (hit.acceptance === "accepted") counted = true;
          else result.legacy_unverified_hits += 1;
          continue;
        }
        if (priorVersions(hit).some((version) => exactVersion(version, incoming))) {
          result.replayed_older_snapshots += 1;
          if (hit.acceptance === "accepted") counted = true;
          else result.legacy_unverified_hits += 1;
          continue;
        }
        const oldOnly = stableKeys(hit.correlation_keys)
          .filter((key) => !incoming.correlation_keys.includes(key));
        if (oldOnly.length) {
          result.conflicts.push(
            `${incoming.date}/${incoming.source} snapshot omits ${oldOnly.length} accepted request identities`
          );
          continue;
        }
        const relation = counterRelation(hit, incoming);
        if (relation === "forward") {
          result.evolved_snapshots += 1;
          continue;
        }
        if (relation === "crossing") {
          result.conflicts.push(
            `${incoming.date}/${incoming.source} has crossing snapshot counters`
          );
          continue;
        }
        result.snapshot_variants.push(
          `${incoming.date}/${incoming.source} has an unrecorded older snapshot version`
        );
        continue;
      }
      const identicalAuthorityReplacement =
        equalKeySets(hit.correlation_keys, keys) &&
        sameAuthorityScope(hit, incoming) &&
        authorityRankOf(hit) !== authorityRankOf(incoming);
      if (identicalAuthorityReplacement) {
        if (hit.acceptance === "accepted") counted = true;
        else result.legacy_unverified_hits += 1;
      } else if (!sameScopeDay(hit, incoming)) {
        result.conflicts.push(
          `${incoming.date}/${incoming.source} overlaps a different scope or day`
        );
      } else if (
        overlap.length &&
        !equalKeySets(hit.correlation_keys, keys)
      ) {
        result.conflicts.push(
          `${incoming.date}/${incoming.source} has partial request overlap`
        );
      } else if (hit.acceptance === "accepted") {
        counted = true;
      } else {
        result.legacy_unverified_hits += 1;
      }
    }
    if (counted) result.replay_receipts += 1;
  }
  return result;
}

export async function assertNoPendingAcceptance(root = process.cwd()) {
  const journal = pathAt(root, ACCEPTANCE_JOURNAL_PATH);
  if (await exists(journal)) {
    throw new Error(
      `Pending evidence acceptance at ${ACCEPTANCE_JOURNAL_PATH}; run ` +
        `node scripts/recover-data-acceptance.js --complete or --rollback`
    );
  }
  const lock = pathAt(root, ACCEPTANCE_LOCK_PATH);
  if (await directoryExists(lock)) {
    throw new Error(`Evidence acceptance lock is held at ${ACCEPTANCE_LOCK_PATH}`);
  }
  const recoveryLock = pathAt(root, RECOVERY_LOCK_PATH);
  if (await directoryExists(recoveryLock)) {
    throw new Error(`Evidence acceptance recovery is active at ${RECOVERY_LOCK_PATH}`);
  }
}

const acquireLock = async (root, relativePath, transactionId) => {
  const lock = pathAt(root, relativePath);
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = "owner unavailable";
    try {
      owner = (await readFile(join(lock, "owner.json"), "utf8")).trim();
    } catch {
      // A missing owner is uncertain and therefore remains locked.
    }
    throw new Error(`Evidence acceptance lock already held: ${owner}`);
  }
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      transaction_id: transactionId,
      started_at: new Date().toISOString()
    }) + "\n",
    { flag: "wx" }
  );
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(join(lock, "owner.json"));
    await rmdir(lock);
  };
};

const validateCorrection = (correction) => {
  if (correction === null || correction === undefined) return null;
  if (
    correction.confirmed !== true ||
    typeof correction.reason !== "string" ||
    !correction.reason.trim()
  ) {
    throw new Error("Correction requires confirmed:true and a nonempty reason");
  }
  return { confirmed: true, reason: correction.reason.trim() };
};

const maybeInterrupt = (point) => {
  if (process.env.DELEGATED_WATCH_ACCEPT_INTERRUPT !== point) return;
  const error = new Error(`Injected evidence acceptance interruption at ${point}`);
  error.simulatedCrash = true;
  throw error;
};

export async function acceptDataset({
  beforeRows,
  rows,
  receipts,
  excludedSources = [],
  root = process.cwd(),
  dryRun = false,
  correction = null
}) {
  if (!Array.isArray(receipts)) throw new Error("receipts must be an array");
  if (!Array.isArray(excludedSources)) {
    throw new Error("excludedSources must be an array");
  }
  const confirmedCorrection = validateCorrection(correction);
  await assertNoPendingAcceptance(root);
  const transactionId = randomUUID();
  const release = await acquireLock(
    root,
    ACCEPTANCE_LOCK_PATH,
    transactionId
  );
  let simulatedCrash = false;
  try {
    const dataPath = pathAt(root, ACCEPTED_DATA_PATH);
    const manifestPath = pathAt(root, ACCEPTED_MANIFEST_PATH);
    const currentData = await readJsonText(dataPath, ACCEPTED_DATA_PATH);
    if (!isDeepStrictEqual(currentData.value, beforeRows)) {
      throw new Error(
        `${ACCEPTED_DATA_PATH} changed after the importer read it; refusing acceptance`
      );
    }
    const currentManifest = await readOptionalManifest(manifestPath);
    const validated = validateAcceptedManifest(currentManifest.value);
    const entries = validated.entries.map((entry) => structuredClone(entry));
    const selected = acceptedReceiptBuckets(
      rows,
      receipts,
      excludedSources
    );
    const changes = { added: 0, updated: 0, promoted: 0, replay: 0 };
    const touchedByBucket = new Map();
    for (const receipt of selected.accepted) {
      const result = addAcceptedEntry(
        entries,
        entryFromReceipt(receipt),
        confirmedCorrection
      );
      changes[result.kind] += 1;
      const key = `${receipt.date}/${receipt.source}`;
      const touched = touchedByBucket.get(key) ?? new Set();
      touched.add(result.entry);
      touchedByBucket.set(key, touched);
    }
    for (const [key, bucket] of selected.buckets) {
      const [date, source] = key.split("/");
      const active = entries.filter(
        (entry) =>
          entry.acceptance === "accepted" &&
          entry.date === date &&
          entry.source === source &&
          isActiveEntry(entry)
      );
      const expected = selected.finalEntries.get(key);
      const counters = (current) => ({
        tokens: current.reduce((sum, entry) => sum + entry.tokens, 0),
        hasCalls: current.some((entry) => Number.isInteger(entry.calls)),
        calls: current.reduce(
          (sum, entry) => sum + (Number.isInteger(entry.calls) ? entry.calls : 0),
          0
        ),
        tokenComponents: aggregateTokenComponents(current)
      });
      let ledger = counters(active);
      const matches = () =>
        ledger.tokens === expected.tokens &&
        (ledger.hasCalls ? ledger.calls === expected.calls : !Number.isInteger(expected.calls)) &&
        isDeepStrictEqual(
          ledger.tokenComponents,
          normalizeTokenComponents(expected.token_components)
        );
      if (!matches() && confirmedCorrection) {
        const touched = touchedByBucket.get(key) ?? new Set();
        for (const entry of active) {
          if (!touched.has(entry)) entry.disposition = "corrected-out";
        }
        ledger = counters(active.filter((entry) => entry.disposition !== "corrected-out"));
      }
      if (!matches()) {
        throw new Error(
          `Accepted ledger for ${key} does not match final dataset counters: ` +
            `ledger ${ledger.tokens}/${ledger.hasCalls ? ledger.calls : "n/a"}, ` +
            `dataset ${expected.tokens}/${expected.calls ?? "n/a"}`
        );
      }
      if (!bucket.length) throw new Error(`Internal error: empty accepted bucket ${key}`);
    }
    const excludedKeys = new Set(
      excludedSources.map((value) =>
        typeof value === "string" ? value : `${value.date}/${value.source}`
      )
    );
    for (const entry of entries) {
      if (excludedKeys.has(`${entry.date}/${entry.source}`)) {
        entry.disposition = "excluded";
      }
    }
    const nextManifest = manifestFromEntries(
      currentManifest.value,
      entries,
      confirmedCorrection
    );
    validateAcceptedManifest(nextManifest);
    const nextDataText = JSON.stringify(rows, null, 2) + "\n";
    const nextManifestText = JSON.stringify(nextManifest, null, 2) + "\n";

    if (dryRun) {
      return {
        dryRun: true,
        changes,
        skipped_receipts: selected.skipped,
        manifest: nextManifest
      };
    }

    const journal = {
      version: 1,
      transaction_id: transactionId,
      created_at: new Date().toISOString(),
      writer: { pid: process.pid, hostname: hostname() },
      files: [
        {
          path: ACCEPTED_DATA_PATH,
          before: byteRecord(currentData.text, true),
          after: byteRecord(nextDataText)
        },
        {
          path: ACCEPTED_MANIFEST_PATH,
          before: byteRecord(currentManifest.text, currentManifest.present),
          after: byteRecord(nextManifestText)
        }
      ]
    };
    await atomicWriteText(
      pathAt(root, ACCEPTANCE_JOURNAL_PATH),
      JSON.stringify(journal, null, 2) + "\n"
    );
    maybeInterrupt("before-files");
    await atomicWriteText(dataPath, nextDataText, 0o644);
    maybeInterrupt("after-first-file");
    await atomicWriteText(manifestPath, nextManifestText, 0o644);
    await unlink(pathAt(root, ACCEPTANCE_JOURNAL_PATH));
    return {
      dryRun: false,
      changes,
      skipped_receipts: selected.skipped,
      manifest: nextManifest
    };
  } catch (error) {
    simulatedCrash = error.simulatedCrash === true;
    throw error;
  } finally {
    if (!simulatedCrash) await release();
  }
}

const ownerState = async (lock) => {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch { // honesty-ok: missing or malformed ownership is deliberately uncertain;
    // recovery must not infer that an unknown writer is dead.
    return { state: "unknown", owner: null };
  }
  if (
    owner.hostname !== hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.transaction_id !== "string" ||
    !owner.transaction_id
  ) {
    return { state: "unknown", owner };
  }
  try {
    process.kill(owner.pid, 0);
    return { state: "live", owner };
  } catch (error) {
    if (error.code === "ESRCH") return { state: "stale", owner };
    return { state: "unknown", owner };
  }
};

const removeKnownStaleLock = async (lock, expectedTransactionId) => {
  let owner;
  try {
    owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (owner.transaction_id !== expectedTransactionId) {
    throw new Error("Acceptance lock belongs to a different transaction");
  }
  await unlink(join(lock, "owner.json"));
  await rmdir(lock);
};

export async function recoverDataAcceptance({
  mode,
  root = process.cwd()
}) {
  if (!new Set(["complete", "rollback"]).has(mode)) {
    throw new Error("Recovery mode must be complete or rollback");
  }
  const recoveryId = randomUUID();
  const releaseRecovery = await acquireLock(root, RECOVERY_LOCK_PATH, recoveryId);
  try {
    const journalPath = pathAt(root, ACCEPTANCE_JOURNAL_PATH);
    const acceptanceLock = pathAt(root, ACCEPTANCE_LOCK_PATH);
    let journal;
    try {
      ({ value: journal } = await readJsonText(
        journalPath,
        ACCEPTANCE_JOURNAL_PATH
      ));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!(await directoryExists(acceptanceLock))) {
        throw new Error("No pending acceptance journal or lock exists");
      }
      const owner = await ownerState(acceptanceLock);
      if (owner.state === "live") {
        throw new Error(
          `Refusing recovery while acceptance writer PID ${owner.owner.pid} is live`
        );
      }
      if (owner.state !== "stale") {
        throw new Error("Refusing recovery because acceptance lock ownership is uncertain");
      }
      await removeKnownStaleLock(
        acceptanceLock,
        owner.owner.transaction_id
      );
      return {
        mode,
        transaction_id: owner.owner.transaction_id,
        lock_only: true
      };
    }
    if (
      journal.version !== 1 ||
      typeof journal.transaction_id !== "string" ||
      !Array.isArray(journal.files) ||
      journal.files.length !== 2 ||
      journal.files[0]?.path !== ACCEPTED_DATA_PATH ||
      journal.files[1]?.path !== ACCEPTED_MANIFEST_PATH
    ) {
      throw new Error("Acceptance journal does not name the fixed canonical file pair");
    }

    if (await directoryExists(acceptanceLock)) {
      const owner = await ownerState(acceptanceLock);
      if (owner.state === "live") {
        throw new Error(
          `Refusing recovery while acceptance writer PID ${owner.owner.pid} is live`
        );
      }
      if (owner.state !== "stale") {
        throw new Error("Refusing recovery because acceptance lock ownership is uncertain");
      }
      if (owner.owner.transaction_id !== journal.transaction_id) {
        throw new Error("Stale acceptance lock does not match the pending journal");
      }
    }

    const targets = [];
    for (const file of journal.files) {
      const beforeText = textOfRecord(file.before, `${file.path} before`);
      const afterText = textOfRecord(file.after, `${file.path} after`);
      const currentFile = await readOptionalText(pathAt(root, file.path));
      const current = byteRecord(currentFile.text, currentFile.present);
      const matchesBefore =
        current.present === file.before.present &&
        current.bytes === file.before.bytes &&
        current.sha256 === file.before.sha256;
      const matchesAfter =
        current.present === file.after.present &&
        current.bytes === file.after.bytes &&
        current.sha256 === file.after.sha256;
      if (!matchesBefore && !matchesAfter) {
        throw new Error(
          `${file.path} matches neither recorded before nor after state; refusing recovery`
        );
      }
      targets.push({
        path: pathAt(root, file.path),
        text:
          (mode === "complete" ? file.after.present : file.before.present)
            ? mode === "complete"
              ? afterText
              : beforeText
            : null,
        already: mode === "complete" ? matchesAfter : matchesBefore
      });
    }

    for (const target of targets) {
      if (target.already) continue;
      if (target.text === null) await unlink(target.path);
      else await atomicWriteText(target.path, target.text, 0o644);
    }
    await unlink(journalPath);
    if (await directoryExists(acceptanceLock)) {
      await removeKnownStaleLock(acceptanceLock, journal.transaction_id);
    }
    return { mode, transaction_id: journal.transaction_id };
  } finally {
    await releaseRecovery();
  }
}
