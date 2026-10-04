import { createHash } from "node:crypto";

export const RECEIPT_SCHEMA_VERSION = 2;
export const TOKEN_COMPONENT_SCHEMA_VERSION = 1;
export const TOKEN_COMPONENT_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "reasoning_tokens"
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AUTHORITIES = new Map([
  ["estimated", 1],
  ["reconstructed", 2],
  ["tool", 3],
  ["provider", 4]
]);

export const authorityRankOf = (receipt) => AUTHORITIES.get(receipt?.authority) ?? 0;

export const sameAuthorityScope = (left, right) =>
  left?.date === right?.date &&
  typeof left?.provider === "string" &&
  left.provider === right?.provider &&
  typeof left?.account_alias === "string" &&
  left.account_alias === right?.account_alias;

const callsOf = (receipt) => receipt.calls ?? 0;
const dominates = (left, right) =>
  left.tokens >= right.tokens && callsOf(left) >= callsOf(right);
const mergeEquivalentCoverage = (left, right) => {
  if (left.coverage !== "incomplete" && right.coverage !== "incomplete") return right;
  return {
    ...right,
    coverage: "incomplete",
    coverage_reasons: [...new Set([
      ...(left.coverage_reasons ?? []),
      ...(right.coverage_reasons ?? [])
    ])].sort()
  };
};

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

export function validateTokenComponents(components, where = "token_components") {
  const errors = [];
  if (!components || typeof components !== "object" || Array.isArray(components)) {
    return [`${where} must be an object`];
  }
  if (components.schema_version !== TOKEN_COMPONENT_SCHEMA_VERSION) {
    errors.push(`${where} schema_version must be ${TOKEN_COMPONENT_SCHEMA_VERSION}`);
  }
  const unknown = Object.keys(components).filter(
    (field) => field !== "schema_version" && !TOKEN_COMPONENT_FIELDS.includes(field)
  );
  if (unknown.length) {
    errors.push(`${where} has unknown fields: ${unknown.sort().join(", ")}`);
  }
  const present = TOKEN_COMPONENT_FIELDS.filter((field) => field in components);
  if (!present.length) {
    errors.push(`${where} requires at least one measured component`);
  }
  for (const field of present) {
    if (!Number.isSafeInteger(components[field]) || components[field] < 0) {
      errors.push(`${where} ${field} must be a nonnegative safe integer`);
    }
  }
  if (
    Number.isSafeInteger(components.cached_input_tokens) &&
    Number.isSafeInteger(components.input_tokens) &&
    components.cached_input_tokens > components.input_tokens
  ) {
    errors.push(`${where} cached_input_tokens must not exceed input_tokens`);
  }
  if (
    Number.isSafeInteger(components.reasoning_tokens) &&
    Number.isSafeInteger(components.output_tokens) &&
    components.reasoning_tokens > components.output_tokens
  ) {
    errors.push(`${where} reasoning_tokens must not exceed output_tokens`);
  }
  return errors;
}

export function normalizeTokenComponents(components) {
  if (components === undefined) return undefined;
  const normalized = { schema_version: TOKEN_COMPONENT_SCHEMA_VERSION };
  for (const field of TOKEN_COMPONENT_FIELDS) {
    if (Object.hasOwn(components, field)) normalized[field] = components[field];
  }
  return normalized;
}

export function reconcileTokenComponents(left, right, where = "token_components") {
  const normalizedLeft = normalizeTokenComponents(left);
  const normalizedRight = normalizeTokenComponents(right);
  if (!normalizedLeft && !normalizedRight) {
    return { token_components: undefined, errors: [] };
  }
  if (!normalizedLeft || !normalizedRight) {
    return {
      token_components: normalizedLeft ?? normalizedRight,
      errors: []
    };
  }
  const tokenComponents = { schema_version: TOKEN_COMPONENT_SCHEMA_VERSION };
  const errors = [];
  for (const field of TOKEN_COMPONENT_FIELDS) {
    const leftPresent = Object.hasOwn(normalizedLeft, field);
    const rightPresent = Object.hasOwn(normalizedRight, field);
    if (leftPresent && rightPresent && normalizedLeft[field] !== normalizedRight[field]) {
      errors.push(`${where} ${field} conflicts between equivalent measurements`);
      continue;
    }
    if (leftPresent || rightPresent) {
      tokenComponents[field] = leftPresent ? normalizedLeft[field] : normalizedRight[field];
    }
  }
  if (!errors.length) errors.push(...validateTokenComponents(tokenComponents, where));
  return { token_components: tokenComponents, errors };
}

export function aggregateTokenComponents(values) {
  if (!values.length) return undefined;
  const components = values.map((value) => value?.token_components);
  const aggregate = { schema_version: TOKEN_COMPONENT_SCHEMA_VERSION };
  let measured = 0;
  for (const field of TOKEN_COMPONENT_FIELDS) {
    if (!components.every((value) => value && Object.hasOwn(value, field))) continue;
    aggregate[field] = components.reduce((sum, value) => sum + value[field], 0);
    measured += 1;
  }
  return measured ? aggregate : undefined;
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
  if ("coverage" in receipt && receipt.coverage !== "incomplete") {
    errors.push(`${where} coverage must be incomplete when present`);
  }
  if ("coverage_reasons" in receipt) {
    if (
      !Array.isArray(receipt.coverage_reasons) ||
      receipt.coverage_reasons.some((value) => typeof value !== "string" || !/^[a-z0-9_]+$/.test(value))
    ) {
      errors.push(`${where} coverage_reasons must be an array of lowercase snake_case values`);
    } else if (JSON.stringify([...new Set(receipt.coverage_reasons)].sort()) !== JSON.stringify(receipt.coverage_reasons)) {
      errors.push(`${where} coverage_reasons must be sorted and unique`);
    }
    if (receipt.coverage !== "incomplete") {
      errors.push(`${where} coverage_reasons require incomplete coverage`);
    }
  }
  if (receipt.coverage === "incomplete" && !receipt.coverage_reasons?.length) {
    errors.push(`${where} incomplete coverage requires coverage_reasons`);
  }
  if ("token_components" in receipt) {
    errors.push(...validateTokenComponents(receipt.token_components, `${where} token_components`));
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
      const equivalentCounters =
        receipt.tokens === existing.tokens && callsOf(receipt) === callsOf(existing);
      if (!equivalentCounters) {
        bySnapshot.set(key, receipt);
        continue;
      }
      const components = reconcileTokenComponents(
        existing.token_components,
        receipt.token_components,
        `${key} token_components`
      );
      if (components.errors.length) {
        errors.push(...components.errors);
        continue;
      }
      const merged = mergeEquivalentCoverage(existing, receipt);
      if (components.token_components) merged.token_components = components.token_components;
      else delete merged.token_components;
      bySnapshot.set(key, merged);
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
      if (!sameAuthorityScope(left, right)) {
        errors.push(
          `identical request set crosses accounting scope between ${left._where} and ${right._where}`
        );
        continue;
      }
      const leftRank = authorityRankOf(left);
      const rightRank = authorityRankOf(right);
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
