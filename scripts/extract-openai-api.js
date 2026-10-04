// Extract reported daily token usage from the OpenAI organization Usage API.
//
// Requires an organization admin key in OPENAI_ADMIN_KEY and an explicit stable,
// non-secret OPENAI_ORGANIZATION_SCOPE matching config/openai-reconciliation.json.
// When the key is absent, the script exits successfully so unattended refreshes
// can still run.
// With the configured UTC day boundary it reads daily completions, embeddings,
// and moderations buckets directly. A non-UTC template uses hourly buckets when
// local midnight is hour-aligned and minute buckets when a fractional offset
// requires them, then groups into its configured calendar day. Non-token usage
// units such as images, audio seconds/characters, vector-store bytes, and Code
// Interpreter sessions are intentionally outside this token dashboard.
//
// Token definition follows the local Codex extractor: non-cached input plus
// output. Cached input is preserved in provenance and excluded from headline
// totals.
//
// Usage:
//   OPENAI_ADMIN_KEY=... OPENAI_ORGANIZATION_SCOPE=... node scripts/extract-openai-api.js
//     [--since YYYY-MM-DD] [--dry-run]
//
// Output defaults to scratch/reconcile/openai-api-<account>.jsonl. Only a dated,
// account-scoped additive decision in config/openai-reconciliation.json releases
// receipts to scratch/receipts/. Files are overwritten per account. Receipts are
// schema v2, account-scoped, with provider authority.
//
// This report covers every API key in the organization, whichever client used
// it. A local extractor that also counted that traffic (Codex signed in with
// an API key, or an editor extension or agent using the same organization's
// key) overlaps it and would be counted twice.

import {
  accountAlias,
  atomicWriteText
} from "./lib/openai-integrity.js";
import {
  nextUsagePage,
  tokenUsageForResult
} from "./lib/openai-usage.js";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const { timezone, windowStart } = await import("./lib/profile.js");
const { accountOrigin } = await import("./lib/origin.js");
const ORIGIN = accountOrigin("openai");
const TIMEZONE = await timezone();
// Overridable only so a test can point this at a loopback server; production
// always reads the real endpoint.
const API_ROOT = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1/organization/usage";
const DEFAULT_SINCE = await windowStart();
const ENDPOINTS = ["completions", "embeddings", "moderations"];
const TOKEN_COMPONENT_FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens"];

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const since = flag("--since") ?? DEFAULT_SINCE;
const dryRun = args.includes("--dry-run");
const adminKey = process.env.OPENAI_ADMIN_KEY;
const displayAccountAlias = accountAlias("openai");
const organizationScope = process.env.OPENAI_ORGANIZATION_SCOPE?.trim() ?? "";
const RECONCILIATION_CONFIG = "config/openai-reconciliation.json";

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must use YYYY-MM-DD.");
  process.exit(64);
}
// Three exit classes for this extractor, in order of how little they say:
//   0  not configured -- no key, so nothing was asked of the provider at all.
//   3  unreachable -- the provider could not be contacted; this run knows
//      nothing about the window, which is UNKNOWN, not a measured zero.
//   1  failed -- everything else, including an HTTP error status the
//      provider did return (an auth failure stays in this class, distinct
//      from unreachable).
if (!adminKey) {
  console.log("OPENAI_ADMIN_KEY not set; skipping OpenAI API extraction.");
  process.exit(0);
}
const configuredAccount = process.env.OPENAI_ACCOUNT_ALIAS ?? process.env.TOKEN_DASHBOARD_ACCOUNT_ALIAS;
if (configuredAccount !== undefined && String(configuredAccount) !== displayAccountAlias) {
  console.error(
    "OpenAI account alias must already be a lowercase filesystem-safe slug using letters, numbers, and hyphens."
  );
  process.exit(64);
}
if (!organizationScope) {
  console.error(
    "OPENAI_ORGANIZATION_SCOPE is required and must match an explicit non-secret account binding; " +
      "no provider request was made and no output was changed."
  );
  process.exit(64);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationScope)) {
  console.error(
    "OPENAI_ORGANIZATION_SCOPE must be a stable non-secret identifier using letters, numbers, dot, underscore, colon, or hyphen."
  );
  process.exit(64);
}
let reconciliationConfig;
try {
  reconciliationConfig = JSON.parse(await readFile(RECONCILIATION_CONFIG, "utf8"));
} catch (error) {
  console.error(
    `OpenAI reconciliation config could not be read as JSON (${error.code ?? error.message}); ` +
      "no provider request was made and no output was changed."
  );
  process.exit(64);
}
const reconciliationErrors = [];
if (reconciliationConfig?.schema_version !== 1) {
  reconciliationErrors.push("schema_version must be 1");
}
if (reconciliationConfig?.default_mode !== "unset") {
  reconciliationErrors.push("default_mode must be unset");
}
if (
  !reconciliationConfig?.accounts ||
  typeof reconciliationConfig.accounts !== "object" ||
  Array.isArray(reconciliationConfig.accounts)
) {
  reconciliationErrors.push("accounts must be an object");
} else {
  const configuredBindings = new Set();
  const configuredScopes = new Set();
  for (const [binding, decision] of Object.entries(reconciliationConfig.accounts)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(binding)) {
      reconciliationErrors.push(`account binding ${binding} is not a lowercase filesystem-safe slug`);
      continue;
    }
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      reconciliationErrors.push(`account binding ${binding} decision must be an object`);
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(decision.account_alias ?? "")) {
      reconciliationErrors.push(`account binding ${binding} account_alias must be a lowercase filesystem-safe slug`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decision.organization_scope ?? "")) {
      reconciliationErrors.push(`account binding ${binding} organization_scope must be a stable non-secret identifier`);
    }
    const configuredBinding = `${decision.account_alias}\u0000${decision.organization_scope}`;
    if (configuredBindings.has(configuredBinding)) {
      reconciliationErrors.push(`account binding ${binding} duplicates another alias and organization scope`);
    }
    configuredBindings.add(configuredBinding);
    if (configuredScopes.has(decision.organization_scope)) {
      reconciliationErrors.push(`account binding ${binding} duplicates another organization scope`);
    }
    configuredScopes.add(decision.organization_scope);
    if (!new Set(["unset", "additive", "overlapping"]).has(decision.mode)) {
      reconciliationErrors.push(`account binding ${binding} mode must be unset, additive, or overlapping`);
      continue;
    }
    if (
      decision.mode !== "unset" &&
      (
        !/^\d{4}-\d{2}-\d{2}$/.test(decision.decided_on ?? "") ||
        typeof decision.evidence !== "string" ||
        !decision.evidence.trim()
      )
    ) {
      reconciliationErrors.push(
        `account binding ${binding} mode ${decision.mode} requires decided_on YYYY-MM-DD and nonempty human scope evidence`
      );
    }
  }
}
if (reconciliationErrors.length) {
  console.error(
    `OpenAI reconciliation config is invalid: ${reconciliationErrors.join("; ")}; ` +
      "no provider request was made and no output was changed."
  );
  process.exit(64);
}
const matchingBindings = Object.values(reconciliationConfig.accounts).filter(
  (decision) =>
    decision.account_alias === displayAccountAlias &&
    decision.organization_scope === organizationScope
);
if (matchingBindings.length !== 1) {
  console.error(
    `The OpenAI alias ${displayAccountAlias} and OPENAI_ORGANIZATION_SCOPE combination does not match a configured account binding; ` +
      "no provider request was made and no output was changed."
  );
  process.exit(64);
}
const reconciliationMode = matchingBindings[0].mode;
const scopeFingerprint = createHash("sha256").update(organizationScope).digest("hex");
const receiptAccount = `${displayAccountAlias}-${scopeFingerprint}`;
const quarantined = reconciliationMode !== "additive";
const OUTPUT_DIRECTORY = quarantined ? "scratch/reconcile" : "scratch/receipts";
const OUTPUT = join(OUTPUT_DIRECTORY, `openai-api-${receiptAccount}.jsonl`);
const IMPORTABLE_ACCOUNT_OUTPUT = join("scratch/receipts", `openai-api-${receiptAccount}.jsonl`);
const PREVIOUS_IMPORTABLE_OUTPUT = join(
  "scratch/reconcile",
  `openai-api-${receiptAccount}.previous-importable.jsonl`
);
const LEGACY_OUTPUT = join("scratch/receipts", "openai-api.jsonl");
const LEGACY_RECOVERY_OUTPUT = join("scratch/reconcile", "openai-api.previous-default.jsonl");

let priorImporterText = null;
let priorRecoveryText = null;
if (quarantined) {
  try {
    priorImporterText = await readFile(IMPORTABLE_ACCOUNT_OUTPUT, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(
        `Prior importer-visible OpenAI output could not be read (${error.code ?? error.message}); ` +
          "no provider request was made and no output was changed."
      );
      process.exit(1);
    }
  }
  if (priorImporterText !== null) {
    try {
      priorRecoveryText = await readFile(PREVIOUS_IMPORTABLE_OUTPUT, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(
          `Prior OpenAI recovery output could not be read (${error.code ?? error.message}); ` +
            "no provider request was made and no output was changed."
        );
        process.exit(1);
      }
    }
    if (priorRecoveryText !== null && priorRecoveryText !== priorImporterText) {
      console.error(
        "Prior importer-visible and recovery OpenAI outputs differ; no provider request was made and no output was changed."
      );
      process.exit(1);
    }
  }
}
const preservePriorAccountOutput = async () => {
  if (!quarantined || priorImporterText === null) return;
  if (priorRecoveryText === null) {
    await atomicWriteText(PREVIOUS_IMPORTABLE_OUTPUT, priorImporterText);
  }
  await unlink(IMPORTABLE_ACCOUNT_OUTPUT);
  console.log(
    `Preserved prior importer-visible OpenAI output at ${PREVIOUS_IMPORTABLE_OUTPUT} and removed it from importer reach.`
  );
  priorImporterText = null;
};

// Transport-level failures a network problem can produce -- the connection
// never reached the provider, so nothing about the window is known. Never
// logged with the request URL's query string or the key.
const UNREACHABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT"
]);

const exitIfUnreachable = (error, host) => {
  const code = error.cause?.code;
  const isAbort = error.name === "AbortError";
  if (!isAbort && !(code && UNREACHABLE_CODES.has(code))) return;
  console.error(
    `OpenAI Organization Usage API unreachable at ${host} (${isAbort ? "timeout" : code}); ` +
      "provider unreachable, this run knows nothing about the requested window."
  );
  process.exit(3);
};

const configuredDay = (unixSeconds) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(unixSeconds * 1000));

const start = new Date(`${since}T00:00:00Z`);
const end = Math.floor(Date.now() / 1000) + 1;
const hasFractionalOffset = (timeZone, first, last) => {
  const minuteFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const sample = new Date(first);
  sample.setUTCHours(0, 0, 0, 0);
  while (sample.getTime() <= last.getTime()) {
    const minute = minuteFormatter.formatToParts(sample).find(({ type }) => type === "minute")?.value;
    if (minute !== "00") return true;
    sample.setUTCDate(sample.getUTCDate() + 1);
  }
  return false;
};
const minuteBuckets = TIMEZONE !== "UTC" && hasFractionalOffset(TIMEZONE, start, new Date(end * 1000));
const bucketWidth = TIMEZONE === "UTC" ? "1d" : minuteBuckets ? "1m" : "1h";
const bucketLimit = TIMEZONE === "UTC" ? "31" : minuteBuckets ? "1440" : "168";
// A non-UTC calendar day can overlap the prior UTC day.
if (TIMEZONE !== "UTC") start.setUTCDate(start.getUTCDate() - 1);

const buckets = new Map();
let pages = 0;
for (const endpoint of ENDPOINTS) {
  let page = null;
  do {
    const url = new URL(`${API_ROOT}/${endpoint}`);
    url.searchParams.set("start_time", String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set("end_time", String(end));
    url.searchParams.set("bucket_width", bucketWidth);
    url.searchParams.set("limit", bucketLimit);
    url.searchParams.append("group_by", "model");
    if (page) url.searchParams.set("page", page);

    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      // One attempt, classified -- no retry-with-sleep here, which would hold
      // an unattended run open against a provider that is not answering.
      exitIfUnreachable(error, url.host);
      // An unrecognized transport error is still "failed", not "unreachable";
      // only the host and error identity are logged, never the URL itself.
      console.error(`OpenAI Organization Usage API request failed at ${url.host}: ${error.cause?.code ?? error.name}`);
      process.exit(1);
    }
    pages += 1;
    if (!response.ok) {
      console.error(
        `OpenAI Usage API ${endpoint} request failed: ${response.status} ${response.statusText}.`
      );
      process.exit(1);
    }
    const body = await response.json();
    for (const apiBucket of body.data ?? []) {
      const date = configuredDay(apiBucket.start_time);
      if (date < since) continue;
      for (const result of apiBucket.results ?? []) {
        const { tokens, cached, components } = tokenUsageForResult(result);
        const bucket = buckets.get(date) ?? {
          date,
          tokens: 0,
          cachedInput: 0,
          calls: 0,
          models: new Set(),
          endpoints: new Set(),
          componentTotals: Object.fromEntries(TOKEN_COMPONENT_FIELDS.map((field) => [field, 0])),
          componentComplete: Object.fromEntries(TOKEN_COMPONENT_FIELDS.map((field) => [field, true]))
        };
        bucket.tokens += tokens;
        bucket.cachedInput += cached;
        bucket.calls += result.num_model_requests ?? 0;
        bucket.endpoints.add(endpoint);
        if (result.model) bucket.models.add(result.model);
        for (const field of TOKEN_COMPONENT_FIELDS) {
          if (field in components) bucket.componentTotals[field] += components[field];
          else bucket.componentComplete[field] = false;
        }
        buckets.set(date, bucket);
      }
    }
    try {
      page = nextUsagePage(body);
    } catch (error) {
      console.error(`OpenAI Usage API ${endpoint} schema error: ${error.message}.`);
      process.exit(1);
    }
  } while (page);
}

const receipts = [...buckets.values()]
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((bucket) => {
    const tokenComponents = { schema_version: 1 };
    for (const field of TOKEN_COMPONENT_FIELDS) {
      if (bucket.componentComplete[field]) tokenComponents[field] = bucket.componentTotals[field];
    }
    return {
      schema_version: RECEIPT_SCHEMA_VERSION,
      date: bucket.date,
      timezone: TIMEZONE,
      source: "openai_api",
      provider: "openai",
      surface: "api",
      account_alias: receiptAccount,
      interval: { start: bucket.date, end: bucket.date },
      snapshot_key: `openai_api:${receiptAccount}:${bucket.date}`,
      authority: "provider",
      models: [...bucket.models].sort(),
      tokens: bucket.tokens,
      calls: bucket.calls,
      fidelity: "exact",
      origin: ORIGIN,
      ...(Object.keys(tokenComponents).length > 1 ? { token_components: tokenComponents } : {}),
      provenance:
        `OpenAI organization Usage API (${[...bucket.endpoints].sort().join(", ")}): ${[...bucket.models].sort().join(", ") || "models not grouped"}; cached_input ${bucket.cachedInput} excluded`
    };
  });

for (const receipt of receipts) {
  const errors = validateReceiptSchema(receipt, `openai_api ${receipt.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
}

let migrateLegacyOutput = false;
let legacyBlocksCurrentOutput = false;
let legacyText = null;
let legacyRecoveryText = null;
const currentDominatesLegacy = (current, legacy) => {
  if (!current || current.tokens < legacy.tokens) return false;
  if (
    Object.hasOwn(legacy, "calls") &&
    (!Object.hasOwn(current, "calls") || current.calls < legacy.calls)
  ) {
    return false;
  }
  for (const [field, value] of Object.entries(legacy.token_components ?? {})) {
    if (field === "schema_version") continue;
    if (
      !current.token_components ||
      !Object.hasOwn(current.token_components, field) ||
      current.token_components[field] < value
    ) {
      return false;
    }
  }
  return true;
};
if (!dryRun && receipts.length) {
  try {
    legacyText = await readFile(LEGACY_OUTPUT, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`ERROR: legacy OpenAI API output could not be read (${error.code ?? error.message}); it was retained.`);
      legacyBlocksCurrentOutput = true;
    }
  }
  if (legacyText !== null && quarantined) {
    migrateLegacyOutput = true;
  } else if (legacyText !== null) {
    let legacyReceipts = null;
    let malformedLegacyOutput = false;
    try {
      legacyReceipts = legacyText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      malformedLegacyOutput = true;
      console.error("WARNING: legacy OpenAI API output is not valid JSONL; it was retained.");
      legacyBlocksCurrentOutput = true;
    }
    const bindingsForDisplayAlias = Object.values(reconciliationConfig.accounts).filter(
      (decision) => decision.account_alias === displayAccountAlias
    ).length;
    const legacyAccountMatches = (receipt) =>
      receipt.account_alias === receiptAccount ||
      (receipt.account_alias === displayAccountAlias && bindingsForDisplayAlias === 1);
    if (
      !malformedLegacyOutput &&
      legacyReceipts?.length &&
      legacyReceipts.every((receipt) =>
        receipt.source === "openai_api" &&
        legacyAccountMatches(receipt) &&
        typeof receipt.snapshot_key === "string" &&
        validateReceiptSchema(receipt, "legacy openai_api").length === 0
      )
    ) {
      const currentByDate = new Map(receipts.map((receipt) => [receipt.date, receipt]));
      const overlappingLegacy = legacyReceipts.filter((receipt) => currentByDate.has(receipt.date));
      if (!overlappingLegacy.length) {
        console.error(
          "WARNING: matching legacy OpenAI API output contains snapshots outside this run; it was retained."
        );
      } else if (
        overlappingLegacy.some((receipt) =>
          !currentDominatesLegacy(currentByDate.get(receipt.date), receipt)
        )
      ) {
        legacyBlocksCurrentOutput = true;
        console.error(
          "WARNING: matching legacy OpenAI API output contains prior evidence; " +
            "current evidence does not equal or dominate it; it was retained."
        );
      } else if (overlappingLegacy.length === legacyReceipts.length) {
        migrateLegacyOutput = legacyReceipts.every((receipt) =>
          currentDominatesLegacy(currentByDate.get(receipt.date), receipt)
        );
      } else {
        legacyBlocksCurrentOutput = true;
        console.error(
          "WARNING: matching legacy OpenAI API output overlaps only part of this run and cannot be migrated atomically; " +
            "it was retained."
        );
      }
    } else if (!malformedLegacyOutput && legacyReceipts?.length) {
      legacyBlocksCurrentOutput = true;
      console.error(
        "WARNING: legacy OpenAI API output does not have an unambiguous matching organization scope; it was retained."
      );
    }
  }
  if (migrateLegacyOutput) {
    try {
      legacyRecoveryText = await readFile(LEGACY_RECOVERY_OUTPUT, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`WARNING: legacy OpenAI recovery output could not be read (${error.code ?? error.message}).`);
        process.exit(1);
      }
    }
    if (legacyRecoveryText !== null && legacyRecoveryText !== legacyText) {
      console.error(
        "Legacy importer-visible and recovery OpenAI outputs differ; no output was changed."
      );
      process.exit(1);
    }
  }
}

if (legacyBlocksCurrentOutput) {
  console.error("No account-specific OpenAI output was written because legacy migration was unsafe.");
  process.exit(1);
}

if (!receipts.length) {
  if (!dryRun) await preservePriorAccountOutput();
  console.log(`No OpenAI API token usage found since ${since} (${pages} API pages); nothing written.`);
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) {
  process.stdout.write(jsonl);
  console.log(`Dry run: ${receipts.length} daily receipts from ${pages} OpenAI Usage API pages.`);
} else {
  let additiveLegacyRemoved = false;
  if (migrateLegacyOutput && !quarantined) {
    try {
      if (legacyRecoveryText === null) {
        await atomicWriteText(LEGACY_RECOVERY_OUTPUT, legacyText);
      }
      try {
        await unlink(LEGACY_OUTPUT);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      additiveLegacyRemoved = true;
    } catch (error) {
      console.error(
        `ERROR: matching legacy OpenAI API output could not be staged outside importer reach (${error.code ?? error.message}); ` +
          "no account-specific output was written."
      );
      process.exit(1);
    }
  }
  try {
    await atomicWriteText(OUTPUT, jsonl);
  } catch (error) {
    if (additiveLegacyRemoved) {
      try {
        let currentLegacyText = null;
        try {
          currentLegacyText = await readFile(LEGACY_OUTPUT, "utf8");
        } catch (readError) {
          if (readError.code !== "ENOENT") throw readError;
        }
        if (currentLegacyText === null) {
          await atomicWriteText(LEGACY_OUTPUT, legacyText);
        } else if (currentLegacyText !== legacyText) {
          throw new Error("a different legacy output appeared during rollback");
        }
      } catch (restoreError) {
        console.error(
          `ERROR: scoped OpenAI output could not be published (${error.code ?? error.message}) and legacy importer-visible output could not be restored ` +
            `(${restoreError.code ?? restoreError.message}); the retained recovery copy is at ${LEGACY_RECOVERY_OUTPUT}.`
        );
        process.exit(1);
      }
      console.error(
        `ERROR: scoped OpenAI output could not be published (${error.code ?? error.message}); ` +
          "legacy importer-visible output was restored."
      );
      process.exit(1);
    }
    throw error;
  }
  await preservePriorAccountOutput();
  if (migrateLegacyOutput) {
    try {
      if (quarantined && legacyRecoveryText === null) {
        await atomicWriteText(LEGACY_RECOVERY_OUTPUT, legacyText);
      }
      if (quarantined) {
        await unlink(LEGACY_OUTPUT);
        console.log(
          `Preserved legacy OpenAI API output at ${LEGACY_RECOVERY_OUTPUT} and removed it from importer reach.`
        );
      } else {
        console.log(
          `Migrated matching legacy OpenAI API output to ${OUTPUT}; ` +
            `the previous default is preserved at ${LEGACY_RECOVERY_OUTPUT}.`
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (quarantined) {
          console.error(
            `ERROR: legacy OpenAI API output could not be removed from importer reach (${error.code ?? error.message}); ` +
              "the quarantined receipt was written, but this run is incomplete."
          );
          process.exit(1);
        }
        console.error(`ERROR: additive legacy migration failed after publication (${error.code ?? error.message}).`);
        process.exit(1);
      }
    }
  }
  console.log(`Wrote ${receipts.length} daily receipts to ${OUTPUT} from ${pages} OpenAI Usage API pages.`);
  if (quarantined) {
    if (reconciliationMode === "overlapping") {
      console.warn(
        `An explicit overlapping decision for ${receiptAccount} keeps the full organization total quarantined and NOT imported; ` +
          "no partial subtraction was attempted or labeled exact."
      );
    } else {
      console.warn(
        `Reconciliation mode for ${receiptAccount} is "${reconciliationMode}": these receipts are NOT imported. ` +
          "Equal aggregate totals cannot establish overlap, subscription Codex is not assumed to overlap, " +
          "and human account/route scope evidence is required before marking this organization additive."
      );
    }
  }
}
