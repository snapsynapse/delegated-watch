// Fail fast on an unsupported Node line before any test or refresh runs. The
// canonical line is pinned in .node-version; scripts/lib/runtime.js holds the
// accepted ranges.
//
// Usage:
//   node scripts/check-runtime.js
import { isSupportedNodeVersion } from "./lib/runtime.js";

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `delegated-watch requires Node 24.18+ on the Node 24 LTS line or verified-compatible Node 26; found ${process.version}.`
  );
  console.error("Use the version recorded in .node-version before running tests or refreshes.");
  process.exit(1);
}

console.log(`Runtime supported: Node ${process.versions.node}.`);
