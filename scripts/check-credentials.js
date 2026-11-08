// Prove the usage-API admin keys are accepted, not just present. A key that
// is set but rejected otherwise surfaces only as an HTTP error partway through
// an extraction, without saying why the key was refused.
//
// One small usage read per provider, for the last day, at the same endpoints
// the extractors use (ANTHROPIC_API_BASE_URL and OPENAI_API_BASE_URL override
// them, as they do for the extractors). Nothing is written. The key is never
// printed; only the provider's error type and code are, never its message,
// which can echo a masked key.
//
// A key that is not set is skipped, not refused: the extractors skip cleanly
// without their keys, so an unset key is a source this machine does not use.
// --provider limits the check to one provider; `npm run refresh` runs it that
// way before each usage-API extractor whose key is set.
//
// Usage:
//   node scripts/check-credentials.js [--provider anthropic|openai]
//
// Exit codes, matching the extractors:
//   0  every key that is set was accepted (or no key is set)
//   1  a key was rejected, or a provider returned another error
//   3  a provider was unreachable; nothing is known about the key
//  64  usage

const ANTHROPIC_API =
  process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com/v1/organizations/usage_report/messages";
const OPENAI_API_ROOT = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1/organization/usage";

// The macOS Keychain prompt behind `security add-generic-password -w` cuts
// pasted input to 128 characters. OpenAI admin keys are longer, so a rejected
// key of exactly that length was almost certainly saved truncated.
const PROMPT_TRUNCATION_LENGTH = 128;

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

const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    variable: "ANTHROPIC_ADMIN_KEY",
    request: (key) => {
      const url = new URL(ANTHROPIC_API);
      url.searchParams.set("starting_at", since.toISOString());
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "1");
      return [url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }];
    }
  },
  {
    id: "openai",
    name: "OpenAI",
    variable: "OPENAI_ADMIN_KEY",
    request: (key) => {
      const url = new URL(`${OPENAI_API_ROOT}/completions`);
      url.searchParams.set("start_time", String(Math.floor(since.getTime() / 1000)));
      url.searchParams.set("limit", "1");
      return [url, { headers: { Authorization: `Bearer ${key}` } }];
    }
  }
];

const args = process.argv.slice(2);
const providerIndex = args.indexOf("--provider");
const wanted = providerIndex === -1 ? null : args[providerIndex + 1];
const unexpected = args.filter((arg, index) => index !== providerIndex && index !== providerIndex + 1);
if (unexpected.length || (providerIndex !== -1 && !PROVIDERS.some(({ id }) => id === wanted))) {
  console.error(`Usage: node scripts/check-credentials.js [--provider ${PROVIDERS.map(({ id }) => id).join("|")}]`);
  process.exit(64);
}

const errorIdentity = async (response) => {
  try {
    const error = (await response.json())?.error ?? {};
    return [error.type, error.code].filter((part) => typeof part === "string" && /^[\w.-]{1,64}$/.test(part)).join(", ");
  } catch (error) { // honesty-ok: the parse error's name is reported; its message can echo the body, which can echo the key.
    // A non-JSON error body still has its HTTP status, which is reported.
    return `error body not JSON (${error.name})`;
  }
};

const checkProvider = async ({ name, variable, request }) => {
  const key = process.env[variable];
  if (!key) return { name, state: "skipped", detail: `${variable} is not set` };
  const [url, options] = request(key);
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    const code = error.name === "TimeoutError" ? "timeout" : error.cause?.code;
    if (code === "timeout" || UNREACHABLE_CODES.has(code)) {
      return { name, state: "unreachable", detail: `${url.host} unreachable (${code})` };
    }
    return { name, state: "failed", detail: `request failed (${error.cause?.code ?? error.name})` };
  }
  if (response.ok) return { name, state: "accepted", detail: `HTTP ${response.status}` };
  const identity = await errorIdentity(response);
  const rejected = response.status === 401 || response.status === 403;
  const truncated = rejected && key.length === PROMPT_TRUNCATION_LENGTH
    ? `; the stored key is exactly ${PROMPT_TRUNCATION_LENGTH} characters, the Keychain prompt's limit, so it was probably saved truncated`
    : "";
  return {
    name,
    state: rejected ? "rejected" : "failed",
    detail: `HTTP ${response.status}${identity ? ` (${identity})` : ""}${truncated}`
  };
};

const results = [];
for (const provider of PROVIDERS.filter(({ id }) => !wanted || id === wanted)) {
  results.push(await checkProvider(provider));
}
for (const { name, state, detail } of results) console.log(`${name} admin key: ${state} -- ${detail}`);

if (results.some(({ state }) => state === "rejected" || state === "failed")) {
  process.exitCode = 1;
} else if (results.some(({ state }) => state === "unreachable")) {
  process.exitCode = 3;
}
