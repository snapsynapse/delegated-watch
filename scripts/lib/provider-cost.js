// Provider-reported cost: a figure the provider itself computed, recorded in
// receipt provenance and nowhere else. The field contract and its validator
// live in receipt-schema.js; this module holds the capture-side helpers the
// extractors and capture scripts use.
//
// This is a tally of a number someone else calculated, never a model. No price
// table is bundled, fetched, or consulted; no cost is computed for a source
// that does not report one; and the figure is never summed into a token total,
// a daily row, or the published page. See INTENT.md, Scope boundaries.

import {
  PROVIDER_COST_BASES,
  PROVIDER_COST_SCHEMA_VERSION,
  validateProviderReportedCost
} from "./receipt-schema.js";

export function providerReportedCost(basis, amount, currency) {
  const definition = PROVIDER_COST_BASES.get(basis);
  if (!definition) return null;
  const cost = {
    schema_version: PROVIDER_COST_SCHEMA_VERSION,
    basis,
    amount,
    currency,
    unit: definition.unit,
    currency_basis: definition.currency_basis
  };
  return validateProviderReportedCost(cost).length ? null : cost;
}

// JSON.parse that remembers the exact source text of every number, so a cost
// sent as `0.00700000` is recorded as that text rather than as whatever a
// double prints. Node 24 supplies the source through the reviver's context.
export function parseJsonWithNumberText(text) {
  const sources = new WeakMap();
  const value = JSON.parse(text, function reviver(key, parsed, context) {
    if (typeof parsed === "number" && typeof context?.source === "string") {
      const holder = sources.get(this) ?? new Map();
      holder.set(key, context.source);
      sources.set(this, holder);
    }
    return parsed;
  });
  return {
    value,
    numberText: (holder, key) =>
      holder && typeof holder === "object" ? sources.get(holder)?.get(key) ?? null : null
  };
}
