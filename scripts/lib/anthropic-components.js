// Token components from Anthropic's four usage counters, shared by the Claude
// Code and Claude API extractors so the mapping is defined once.
//
// Anthropic reports cache reads and cache writes outside its input count. The
// component contract (DATA_CONTRACT.md, Token components) counts cached input
// as a subset of input, so the components are mapped to that convention:
//
//   input_tokens        = uncached input + cache writes + cache reads
//   cached_input_tokens = cache reads
//   cache_write_tokens  = cache writes
//   output_tokens       = output
//
// Under the contract's headline rule, max(0, input - cached) + output, that
// gives back exactly the headline these extractors already record: uncached
// input plus cache writes plus output, with cache reads excluded.
//
// A component is emitted for a day only when every record in it reported the
// counters it needs. A counter one record left out is unavailable for the day,
// never a measured zero, so a partial sum is never presented as a whole one.

const FIELDS = ["uncached", "cacheWrite", "cacheRead", "output"];

export function newAnthropicTally() {
  return { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, missing: new Set() };
}

// counters: { uncached, cacheWrite, cacheRead, output }, each a nonnegative
// integer as reported, or null/undefined when the record did not report it.
export function addAnthropicCounters(tally, counters) {
  for (const field of FIELDS) {
    const value = counters[field];
    if (value == null) tally.missing.add(field);
    else tally[field] += value;
  }
  return tally;
}

// Returns a token_components object, or null when no component was reported
// in full across the day.
export function anthropicComponents(tally) {
  const has = (...fields) => fields.every((field) => !tally.missing.has(field));
  const components = {};
  if (has("uncached", "cacheWrite", "cacheRead")) {
    components.input_tokens = tally.uncached + tally.cacheWrite + tally.cacheRead;
  }
  if (has("cacheRead")) components.cached_input_tokens = tally.cacheRead;
  if (has("cacheWrite")) components.cache_write_tokens = tally.cacheWrite;
  if (has("output")) components.output_tokens = tally.output;
  return Object.keys(components).length ? { schema_version: 1, ...components } : null;
}
