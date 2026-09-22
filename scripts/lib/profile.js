// Single source of truth for personal values, per INTENT invariant 8. Every
// script reads timezone and window start from here rather than hardcoding them,
// so changing the day-grouping basis is one edit rather than a dozen.

import { readFile } from "node:fs/promises";

// Resolved against this module, not the working directory. Extractors are run
// from temp directories in tests and from the repo root in production; the
// profile is a property of the repo either way.
const CONFIG = new URL("../../config/profile.json", import.meta.url);

let cached = null;

export async function profile() {
  if (cached) return cached;
  const parsed = JSON.parse(await readFile(CONFIG, "utf8"));
  if (!parsed.timezone) throw new Error(`config/profile.json: timezone is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.window_start ?? "")) {
    throw new Error(`config/profile.json: window_start must be YYYY-MM-DD`);
  }
  if (parsed.origin && !/^[a-z0-9][a-z0-9._/-]*$/.test(parsed.origin)) {
    throw new Error(`config/profile.json: origin is invalid`);
  }
  if (parsed.machine_alias && !/^[a-z0-9][a-z0-9._-]*$/.test(parsed.machine_alias)) {
    throw new Error(`config/profile.json: machine_alias is invalid`);
  }
  // Fail loudly on a bad IANA zone rather than silently bucketing wrong.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: parsed.timezone });
  } catch {
    throw new Error(`config/profile.json: "${parsed.timezone}" is not a valid IANA timezone`);
  }
  cached = parsed;
  return cached;
}

// Calendar day in the configured zone. The single function every extractor uses,
// so no source can drift to a different day boundary.
export async function dayOf(isoTimestamp) {
  const { timezone } = await profile();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(isoTimestamp));
}

export async function timezone() {
  return (await profile()).timezone;
}

export async function windowStart() {
  return (await profile()).window_start;
}

// Days at or before this date are final: no provider read may revise them.
// A provider's own aggregate can disagree with itself long after the traffic
// stopped, so re-reading an old day measures the provider's rollup rather than
// the work, and an unstable rollup then looks exactly like a correction.
// Absent or zero means no horizon, which is the pre-2026-09 behaviour.
export async function finalizedThrough(now = new Date()) {
  const days = (await profile()).finalize_after_days;
  if (!Number.isInteger(days) || days <= 0) return null;
  const cut = new Date(now);
  cut.setUTCDate(cut.getUTCDate() - days);
  return cut.toISOString().slice(0, 10);
}
