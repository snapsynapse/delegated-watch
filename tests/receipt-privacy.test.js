import test from "node:test";
import assert from "node:assert/strict";
import { privateTextFindings, receiptPrivacyFindings } from "../scripts/lib/receipt-privacy.js";

const receipt = () => ({ date: "2026-01-01", source: "local_model", tokens: 123,
  calls: 2, fidelity: "exact", origin: "machine/example", provenance: "Native response counters" });

test("privacy accepts scrubbed legacy and v2 receipt metadata", () => {
  assert.deepEqual(receiptPrivacyFindings(receipt()), []);
  assert.deepEqual(privateTextFindings("transcript counters: <synthetic>"), []);
  assert.deepEqual(receiptPrivacyFindings({ ...receipt(), schema_version: 2,
    provider: "example", surface: "api", account_alias: "primary", authority: "provider",
    interval: { start: "2026-01-01", end: "2026-01-01" }, snapshot_key: "example:request-1",
    models: ["example/model"], correlation_keys: [`sha256:${"a".repeat(64)}`] }), []);
});

test("every source and nested metadata field is checked without echoing secrets", () => {
  for (const source of ["claude_code", "perplexity_api", "gemma_local", "new_provider"]) {
    const secret = `pplx-${"x".repeat(32)}`;
    const findings = receiptPrivacyFindings({ ...receipt(), source, models: [secret] });
    assert(findings.some((finding) => finding.includes("secret-like")));
    assert(!JSON.stringify(findings).includes(secret));
  }
  assert(receiptPrivacyFindings({ ...receipt(), interval: { start: "2026-01-01", end: "2026-01-01", prompt: "hidden" } }).length);
  const contentKey = "private conversation content";
  const findings = receiptPrivacyFindings({ ...receipt(), [contentKey]: "hidden" });
  assert.deepEqual(findings, ["unapproved receipt field"]);
  assert(!JSON.stringify(findings).includes(contentKey));
});

test("metadata rejects content-bearing shapes and unhashed correlation keys", () => {
  for (const extra of [{ models: [{ prompt: "secret" }] }, { correlation_keys: ["raw-request"] },
    { tokens: { prompt: "secret" } }, { provenance: null }, { interval: [] }]) {
    assert(receiptPrivacyFindings({ ...receipt(), ...extra }).length);
  }
  for (const text of ["/home/example/private", "C:\\Users\\example\\private", "https://example.org/private", "Bearer secret", "person@example.org", "<script>alert(1)</script>"]) {
    assert(privateTextFindings(text).length);
  }
});
