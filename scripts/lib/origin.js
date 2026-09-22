// Where a receipt's evidence came from.
//
// The unit is NOT the device. A Mac with three user profiles has one hostname
// but three separate `$HOME/.claude/projects` stores, so tagging by hostname
// alone makes three profiles indistinguishable once their receipts are summed.
// The pair (machine, profile) is what selects a store, so that pair is the
// identity: `example-laptop/alice`.
//
// Account-scoped sources have no machine at all. Anthropic's Admin Usage API
// reports the organization's usage regardless of which machine made the calls,
// so those receipts carry an account origin instead and must never be attributed
// to whichever machine happened to run the fetch.

import { hostname, userInfo } from "node:os";
import { profile } from "./profile.js";

const ORIGIN_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

const slug = (value) =>
  String(value)
    .normalize("NFKD")
    .replace(/[‘’'']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// A machine-local store: this device, this profile.
export async function localOrigin(override) {
  if (override) return assertOrigin(override);
  const configured = (await profile()).origin;
  if (configured) return assertOrigin(configured);
  const host = slug(hostname().replace(/\.local$/i, ""));
  const user = slug(userInfo().username);
  return `${host}/${user}`;
}

// An account-scoped source, reported by the provider rather than observed on a
// machine. Kept distinct so a future "which machine" breakdown never silently
// credits API usage to the box that ran the extractor.
export function accountOrigin(provider) {
  return assertOrigin(`account/${slug(provider)}`);
}

export function assertOrigin(value) {
  const origin = String(value).trim();
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      `origin "${origin}" must be lowercase alphanumeric with . _ - / separators, e.g. "mbp16/snap" or "account/anthropic"`
    );
  }
  return origin;
}

export function isAccountOrigin(value) {
  return String(value).startsWith("account/");
}
