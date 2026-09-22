import { createHash } from "node:crypto";

export const RECEIPT_SCHEMA_VERSION = 2;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AUTHORITIES = new Map([
  ["estimated", 1],
  ["reconstructed", 2],
  ["tool", 3],
  ["provider", 4]
]);

const callsOf = (receipt) => receipt.calls ?? 0;
const dominates = (left, right) =>
  left.tokens >= right.tokens && callsOf(left) >= callsOf(right);

export const snapshotKeyOf = (receipt) =>
  receipt.snapshot_key ?? receipt.dedupe_key ?? null;

export const hashCorrelationKey = (value) =>
  `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

// Capture transport is provenance, not a separate inference surface. Restrict
// this compatibility mapping to the two historical Perplexity capture values.
export function normalizeReceipt(receipt) {
  if (receipt?.source === "perplexity_api" && receipt.provider === "perplexity" &&
      ["native_api_capture", "tool_result_capture"].includes(receipt.surface) &&
      String(snapshotKeyOf(receipt) ?? "").startsWith("perplexity:")) {
    return { ...receipt, surface: "api", capture_method: receipt.surface };
  }
  return receipt;
}

export function validateReceiptSchema(receipt, where = "receipt") {
  const errors = [];
  if (receipt.schema_version === undefined) return errors;
  if (receipt.schema_version !== RECEIPT_SCHEMA_VERSION) {
    return [`${where} schema_version must be ${RECEIPT_SCHEMA_VERSION}`];
  }
  for (const field of [
    "provider",
    "surface",
    "account_alias",
    "snapshot_key",
    "authority"
  ]) {
    if (typeof receipt[field] !== "string" || !receipt[field].trim()) {
      errors.push(`${where} ${field} must be a nonempty string`);
    }
  }
  if (!AUTHORITIES.has(receipt.authority)) {
    errors.push(`${where} authority must be provider, tool, reconstructed, or estimated`);
  }
  if (!receipt.origin && !receipt.machine_alias) {
    errors.push(`${where} requires origin or machine_alias`);
  }
  const interval = receipt.interval;
  if (
    !interval ||
    !DATE.test(interval.start ?? "") ||
    !DATE.test(interval.end ?? "") ||
    interval.start > receipt.date ||
    interval.end < receipt.date
  ) {
    errors.push(`${where} interval must contain receipt.date`);
  }
  for (const field of ["models", "correlation_keys"]) {
    if (!(field in receipt)) continue;
    if (
      !Array.isArray(receipt[field]) ||
      receipt[field].some((value) => typeof value !== "string" || !value.trim())
    ) {
      errors.push(`${where} ${field} must be an array of nonempty strings`);
      continue;
    }
    const sorted = [...new Set(receipt[field])].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(receipt[field])) {
      errors.push(`${where} ${field} must be sorted and unique`);
    }
    if (
      field === "correlation_keys" &&
      receipt[field].some((value) => !/^sha256:[a-f0-9]{64}$/.test(value))
    ) {
      errors.push(`${where} correlation_keys must contain SHA-256 values`);
    }
  }
  return errors;
}

export function reconcileReceipts(input) {
  const errors = [];
  const unsnapshotted = [];
  const bySnapshot = new Map();

  for (const raw of input) {
    const receipt = normalizeReceipt(raw);
    const key = snapshotKeyOf(receipt);
    if (!key) {
      unsnapshotted.push(receipt);
      continue;
    }
    const existing = bySnapshot.get(key);
    if (!existing) {
      bySnapshot.set(key, receipt);
      continue;
    }
    if (
      existing.date !== receipt.date ||
      existing.source !== receipt.source ||
      existing.fidelity !== receipt.fidelity ||
      existing.provider !== receipt.provider ||
      existing.surface !== receipt.surface ||
      existing.account_alias !== receipt.account_alias ||
      existing.origin !== receipt.origin ||
      existing.machine_alias !== receipt.machine_alias
    ) {
      errors.push(`${key} conflicts between ${existing._where} and ${receipt._where}`);
      continue;
    }
    if (dominates(receipt, existing)) {
      if ((existing.correlation_keys ?? []).some((key) => !(receipt.correlation_keys ?? []).includes(key))) {
        errors.push(`${key} newer snapshot omits previously observed request identities`);
        continue;
      }
      bySnapshot.set(key, receipt);
    } else if (!dominates(existing, receipt)) {
      errors.push(
        `${key} has crossing token/call snapshots at ${existing._where} and ${receipt._where}`
      );
    } else if ((receipt.correlation_keys ?? []).some((key) => !(existing.correlation_keys ?? []).includes(key))) {
      errors.push(`${key} retained snapshot omits previously observed request identities`);
    }
  }

  const reconciled = [...unsnapshotted, ...bySnapshot.values()];
  const dropped = new Set();
  for (let leftIndex = 0; leftIndex < reconciled.length; leftIndex += 1) {
    const left = reconciled[leftIndex];
    const leftKeys = left.correlation_keys ?? [];
    if (!leftKeys.length || dropped.has(leftIndex)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < reconciled.length; rightIndex += 1) {
      const right = reconciled[rightIndex];
      const rightKeys = right.correlation_keys ?? [];
      if (!rightKeys.length || dropped.has(rightIndex)) continue;
      const overlap = leftKeys.filter((key) => rightKeys.includes(key));
      if (!overlap.length) continue;
      const identical =
        leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index]);
      if (!identical) {
        errors.push(
          `partial request overlap (${overlap.join(", ")}) between ${left._where} and ${right._where}`
        );
        continue;
      }
      if (left.date !== right.date) {
        errors.push(
          `identical request set crosses dates between ${left._where} and ${right._where}`
        );
        continue;
      }
      const leftRank = AUTHORITIES.get(left.authority) ?? 0;
      const rightRank = AUTHORITIES.get(right.authority) ?? 0;
      if (leftRank === rightRank) {
        errors.push(
          `identical request set has equal authority at ${left._where} and ${right._where}`
        );
      } else if (leftRank > rightRank) {
        dropped.add(rightIndex);
      } else {
        dropped.add(leftIndex);
        break;
      }
    }
  }

  return {
    receipts: reconciled.filter((_, index) => !dropped.has(index)),
    errors
  };
}
