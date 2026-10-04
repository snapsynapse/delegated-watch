// The two organization usage API extractors. Every test is local: a loopback
// server stands in for the provider, or fetch is replaced by a stub before the
// extractor runs, so no request ever leaves the machine. No key used here is
// real, and every test asserts the key never reaches output.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const KEY = "test-not-a-real-key";
const scopedAccount = (alias, scope) =>
  `${alias}-${createHash("sha256").update(scope).digest("hex")}`;
const PRIMARY_SCOPE = "scope-primary";
const PRIMARY_ACCOUNT = scopedAccount("primary", PRIMARY_SCOPE);
const openAIDecision = (mode, evidence = `Human scope evidence for ${mode}.`) => ({
  mode,
  decided_on: "2026-10-03",
  evidence
});
const writeOpenAIConfig = (cwd, accounts = { primary: { mode: "unset" } }) =>
  writeFile(join(cwd, "config", "openai-reconciliation.json"), JSON.stringify({
    schema_version: 1,
    default_mode: "unset",
    accounts: Object.fromEntries(Object.entries(accounts).map(([binding, decision]) => {
      if (decision.account_alias && decision.organization_scope) return [binding, decision];
      return [`${binding}-binding`, {
        account_alias: binding,
        organization_scope: `scope-${binding}`,
        ...decision
      }];
    }))
  }));

const workdir = async (mode = "unset") => {
  const cwd = await mkdtemp(join(tmpdir(), "usage-api-"));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(join(cwd, "config", "claude-reconciliation.json"), JSON.stringify({ mode }));
  await writeOpenAIConfig(cwd);
  return cwd;
};

const run = (script, args, env, cwd, preload = []) => new Promise((done) => {
  const scriptPath = env.TEST_SCRIPT_ROOT
    ? join(env.TEST_SCRIPT_ROOT, script)
    : join(repo, "scripts", script);
  const child = spawn(process.execPath, [...preload, scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_ADMIN_KEY: "",
      OPENAI_ADMIN_KEY: "",
      OPENAI_ORGANIZATION_SCOPE:
        Object.hasOwn(env, "OPENAI_ORGANIZATION_SCOPE")
          ? env.OPENAI_ORGANIZATION_SCOPE
          : `scope-${env.OPENAI_ACCOUNT_ALIAS ?? env.TOKEN_DASHBOARD_ACCOUNT_ALIAS ?? "primary"}`,
      ...env,
      TEST_SCRIPT_ROOT: undefined
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => done({ status, stdout, stderr }));
});
const receiptsIn = (text) => text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const localOpenAIExtractor = async (cwd, timezone) => {
  const scripts = join(cwd, "scripts");
  await cp(join(repo, "scripts"), scripts, { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(cwd, "config", "profile.json"), JSON.stringify({
    timezone,
    window_start: "2026-01-01"
  }));
  return scripts;
};

const stubbedUsagePages = async (cwd, routes) => {
  const path = join(cwd, "usage-fetch-stub.mjs");
  const requests = join(cwd, "usage-requests.jsonl");
  await writeFile(path, [
    'import { appendFileSync } from "node:fs";',
    `const routes = ${JSON.stringify(routes)};`,
    `const requests = ${JSON.stringify(requests)};`,
    "globalThis.fetch = async (input) => {",
    "  const url = new URL(input);",
    "  appendFileSync(requests, JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams) }) + \"\\n\");",
    "  const route = routes[url.pathname] ?? {};",
    "  const pages = route[url.searchParams.get(\"bucket_width\")] ?? [{ data: [], has_more: false }];",
    "  const body = pages[url.searchParams.has(\"page\") ? 1 : 0] ?? { data: [], has_more: false };",
    "  return new Response(JSON.stringify(body), { headers: { \"content-type\": \"application/json\" } });",
    "};"
  ].join("\n") + "\n");
  return {
    preload: ["--import", path],
    requests: async () => (await readFile(requests, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  };
};

// Serves canned pages keyed by path and page token; records what was asked.
const provider = async (routes) => {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ path: url.pathname, headers: req.headers });
    const pages = routes[url.pathname] ?? [{ data: [], has_more: false }];
    const body = pages[url.searchParams.get("page") ? 1 : 0];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
};

const hour = (day, h) => new Date(Date.UTC(2026, 0, day, h)).toISOString();
const second = (day) => Date.UTC(2026, 0, day) / 1000;

test("Anthropic usage becomes provider-authority v2 receipts, quarantined until reconciled", async () => {
  const api = await provider({
    "/usage": [
      { data: [
        { starting_at: hour(2, 10), results: [{ model: "claude-a", uncached_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 }, cache_read_input_tokens: 5000, output_tokens: 40 }] }
      ], has_more: true, next_page: "p2" },
      { data: [{ starting_at: hour(3, 0), results: [{ model: "claude-a", uncached_input_tokens: 11, cache_read_input_tokens: 9, output_tokens: 2 }] }], has_more: false }
    ]
  });
  try {
    const cwd = await workdir();
    const env = { ANTHROPIC_ADMIN_KEY: KEY, ANTHROPIC_API_BASE_URL: `${api.base}/usage` };
    const result = await run("extract-claude-api.js", ["--since", "2026-01-01", "--pace", "0"], env, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /NOT imported/);
    assert.deepEqual(await readdir(join(cwd, "scratch")), ["reconcile"]);
    const receipts = receiptsIn(await readFile(join(cwd, "scratch", "reconcile", "claude-api.jsonl"), "utf8"));
    assert.deepEqual(receipts.map((r) => [r.date, r.tokens]), [["2026-01-02", 190], ["2026-01-03", 13]]);
    for (const receipt of receipts) {
      assert.deepEqual(validateReceiptSchema(receipt), []);
      assert.equal(receipt.authority, "provider");
      assert.equal(receipt.origin, "account/anthropic");
    }
    assert.match(receipts[0].provenance, /cache_read 5000 excluded/);
    assert.equal(api.seen[0].headers["x-api-key"], KEY);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));

    const additive = await workdir("additive");
    assert.equal((await run("extract-claude-api.js", ["--since", "2026-01-01", "--pace", "0"], env, additive)).status, 0);
    assert.deepEqual(await readdir(join(additive, "scratch")), ["receipts"]);
  } finally {
    api.close();
  }
});

test("OpenAI usage sums text endpoints, excludes cached input, and fails on a broken page", async () => {
  const api = await provider({
    "/org/completions": [
      { data: [{ start_time: second(2), results: [{ model: "gpt-a", input_tokens: 1000, input_cached_tokens: 400, output_tokens: 50, num_model_requests: 3 }] }], has_more: true, next_page: "c2" },
      { data: [{ start_time: second(3), results: [{ model: "gpt-b", input_tokens: 10, output_tokens: 5, num_model_requests: 1 }] }], has_more: false }
    ],
    "/org/embeddings": [{ data: [{ start_time: second(2), results: [{ model: "emb", input_tokens: 300, num_model_requests: 2 }] }], has_more: false }]
  });
  try {
    const cwd = await workdir();
    const env = { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: `${api.base}/org` };
    const result = await run("extract-openai-api.js", ["--since", "2026-01-01", "--dry-run"], env, cwd);
    assert.equal(result.status, 0, result.stderr);
    const receipts = receiptsIn(result.stdout);
    assert.deepEqual(receipts.map((r) => [r.date, r.tokens, r.calls]), [["2026-01-02", 950, 5], ["2026-01-03", 15, 1]]);
    for (const receipt of receipts) {
      assert.deepEqual(validateReceiptSchema(receipt), []);
      assert.equal(receipt.origin, "account/openai");
    }
    assert.match(receipts[0].provenance, /cached_input 400 excluded/);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
  } finally {
    api.close();
  }

  const broken = await provider({ "/org/completions": [{ data: [], has_more: true }] });
  try {
    const result = await run("extract-openai-api.js", ["--since", "2026-01-01", "--dry-run"],
      { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: `${broken.base}/org` }, await workdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has_more without next_page/);
  } finally {
    broken.close();
  }
});

test("OpenAI organization usage is quarantined by default without inferring client overlap", async () => {
  const cwd = await workdir();
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{
        data: [{
          start_time: second(2),
          results: [{ model: "gpt-provider", input_tokens: 100, input_cached_tokens: 0, output_tokens: 20, num_model_requests: 1 }]
        }],
        has_more: false
      }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(join(cwd, "scratch")), ["reconcile"]);
  const output = join(cwd, "scratch", "reconcile", `openai-api-${PRIMARY_ACCOUNT}.jsonl`);
  assert.deepEqual(receiptsIn(await readFile(output, "utf8")).map(({ tokens }) => tokens), [120]);
  assert.match(result.stderr, /NOT imported/);
  assert.match(result.stderr, /equal aggregate totals cannot establish overlap/i);
  assert.match(result.stderr, /subscription Codex is not assumed to overlap/i);
  assert.match(result.stderr, /human.*scope evidence.*required/i);
});

test("OpenAI fails closed before network when reconciliation config is missing or malformed", async () => {
  for (const mutateConfig of [
    (path) => unlink(path),
    (path) => writeFile(path, "{not-json")
  ]) {
    const cwd = await workdir();
    const config = join(cwd, "config", "openai-reconciliation.json");
    await mutateConfig(config);
    const stub = await stubbedUsagePages(cwd, {});
    const result = await run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
      cwd,
      stub.preload
    );

    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /reconciliation config.*no provider request.*no output was changed/i);
    assert.deepEqual(await stub.requests(), []);
    await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });
  }
});

test("OpenAI refuses additive mode without account-scoped human evidence", async () => {
  const cwd = await workdir();
  await writeFile(join(cwd, "config", "openai-reconciliation.json"), JSON.stringify({
    schema_version: 1,
    default_mode: "unset",
    accounts: {
      "primary-binding": {
        account_alias: "primary",
        organization_scope: PRIMARY_SCOPE,
        mode: "additive"
      }
    }
  }));
  const stub = await stubbedUsagePages(cwd, {});
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /additive.*requires.*decided_on.*human scope evidence/i);
  assert.deepEqual(await stub.requests(), []);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });
});

test("OpenAI releases only an account with a dated additive scope decision", async () => {
  const cwd = await workdir();
  await writeFile(join(cwd, "config", "openai-reconciliation.json"), JSON.stringify({
    schema_version: 1,
    default_mode: "unset",
    accounts: {
      "org-additive": {
        account_alias: "org-additive",
        organization_scope: "scope-org-additive",
        mode: "additive",
        decided_on: "2026-10-03",
        evidence: "Human verified this organization's API-key traffic is outside every counted client scope."
      }
    }
  }));
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "account-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_ACCOUNT_ALIAS: "org-additive",
      OPENAI_API_BASE_URL: "https://fixture.invalid/org"
    },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(join(cwd, "scratch")), ["receipts"]);
  const additiveAccount = scopedAccount("org-additive", "scope-org-additive");
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), [`openai-api-${additiveAccount}.jsonl`]);
  assert.match(result.stdout, new RegExp(`scratch/receipts/openai-api-${additiveAccount}\\.jsonl`));
  assert.doesNotMatch(result.stderr, /NOT imported/);
});

test("OpenAI overlapping mode quarantines the full provider total without partial subtraction", async () => {
  const cwd = await workdir();
  await writeFile(join(cwd, "config", "openai-reconciliation.json"), JSON.stringify({
    schema_version: 1,
    default_mode: "unset",
    accounts: {
      "org-overlap": {
        account_alias: "org-overlap",
        organization_scope: "scope-org-overlap",
        mode: "overlapping",
        decided_on: "2026-10-03",
        evidence: "Human verified that this organization total includes API-key client receipts already counted elsewhere."
      }
    }
  }));
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "provider-total", input_tokens: 100000, input_cached_tokens: 0, output_tokens: 20000, num_model_requests: 2 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_ACCOUNT_ALIAS: "org-overlap",
      OPENAI_API_BASE_URL: "https://fixture.invalid/org"
    },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  const output = join(
    cwd,
    "scratch",
    "reconcile",
    `openai-api-${scopedAccount("org-overlap", "scope-org-overlap")}.jsonl`
  );
  const [receipt] = receiptsIn(await readFile(output, "utf8"));
  assert.equal(receipt.tokens, 120000);
  assert.equal(receipt.fidelity, "exact");
  assert.match(result.stderr, /explicit overlapping decision.*full organization total.*quarantined/i);
  assert.match(result.stderr, /no partial subtraction/i);
});

test("OpenAI quarantine preserves and removes a prior account output from importer reach", async () => {
  const cwd = await workdir();
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(receiptDir, { recursive: true });
  const priorOutput = join(receiptDir, `openai-api-${PRIMARY_ACCOUNT}.jsonl`);
  const priorBytes = "prior importer-visible OpenAI receipt bytes\n";
  await writeFile(priorOutput, priorBytes);
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "provider-total", input_tokens: 100, input_cached_tokens: 0, output_tokens: 20, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(receiptDir), []);
  const recovery = join(cwd, "scratch", "reconcile", `openai-api-${PRIMARY_ACCOUNT}.previous-importable.jsonl`);
  assert.equal(await readFile(recovery, "utf8"), priorBytes);
  assert.match(result.stdout, /Preserved prior importer-visible OpenAI output/);
  assert.equal(
    receiptsIn(await readFile(join(cwd, "scratch", "reconcile", `openai-api-${PRIMARY_ACCOUNT}.jsonl`), "utf8"))[0].tokens,
    120
  );
});

test("OpenAI quarantine removes prior account output even when the current window has no usage", async () => {
  const cwd = await workdir();
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(receiptDir, { recursive: true });
  const priorOutput = join(receiptDir, `openai-api-${PRIMARY_ACCOUNT}.jsonl`);
  const priorBytes = "historical importer-visible OpenAI receipt bytes\n";
  await writeFile(priorOutput, priorBytes);
  const stub = await stubbedUsagePages(cwd, {});
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(receiptDir), []);
  assert.equal(
    await readFile(join(cwd, "scratch", "reconcile", `openai-api-${PRIMARY_ACCOUNT}.previous-importable.jsonl`), "utf8"),
    priorBytes
  );
  assert.match(result.stdout, /No OpenAI API token usage found/);
});

test("OpenAI quarantine preserves any legacy default output before removing it", async () => {
  const cwd = await workdir();
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(receiptDir, { recursive: true });
  const legacy = join(receiptDir, "openai-api.jsonl");
  const legacyBytes = "legacy OpenAI bytes that are not valid receipt JSONL\n";
  await writeFile(legacy, legacyBytes);
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "current-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(receiptDir), []);
  const recovery = join(cwd, "scratch", "reconcile", "openai-api.previous-default.jsonl");
  assert.equal(await readFile(recovery, "utf8"), legacyBytes);
  assert.match(result.stdout, /Preserved legacy OpenAI API output/);
});

test("OpenAI reconciliation decisions do not bleed across organizations", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "org-a": openAIDecision("additive"),
    "org-b": { mode: "unset" }
  });
  const runAccount = async (alias, tokens) => {
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": {
        "1d": [{ data: [{
          start_time: second(2),
          results: [{ model: alias, input_tokens: tokens, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
        }], has_more: false }]
      }
    });
    return run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      {
        OPENAI_ADMIN_KEY: KEY,
        OPENAI_ACCOUNT_ALIAS: alias,
        OPENAI_API_BASE_URL: "https://fixture.invalid/org"
      },
      cwd,
      stub.preload
    );
  };

  const additive = await runAccount("org-a", 100);
  const unreviewed = await runAccount("org-b", 200);
  assert.equal(additive.status, 0, additive.stderr);
  assert.equal(unreviewed.status, 0, unreviewed.stderr);
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), [
    `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`
  ]);
  assert.deepEqual(await readdir(join(cwd, "scratch", "reconcile")), [
    `openai-api-${scopedAccount("org-b", "scope-org-b")}.jsonl`
  ]);
  assert.match(unreviewed.stderr, /NOT imported/);
});

test("OpenAI uses paginated minute buckets when a fractional offset crosses the since boundary", async () => {
  const cwd = await workdir();
  const scriptRoot = await localOpenAIExtractor(cwd, "Asia/Kolkata");
  const beforeMidnight = Date.parse("2026-01-01T18:00:00Z") / 1000;
  const afterMidnight = Date.parse("2026-01-01T18:45:00Z") / 1000;
  const perEndpoint = (tokens) => ({
    "1h": [{
      data: [{ start_time: beforeMidnight, results: [{ model: "wrong-day", input_tokens: tokens, output_tokens: 0, num_model_requests: 1 }] }],
      has_more: false
    }],
    "1m": [
      {
        data: [{ start_time: afterMidnight, results: [{ model: "minute-model", input_tokens: tokens, output_tokens: 0, num_model_requests: 1 }] }],
        has_more: true,
        next_page: "p2"
      },
      { data: [], has_more: false }
    ]
  });
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": perEndpoint(10),
    "/org/embeddings": perEndpoint(20),
    "/org/moderations": perEndpoint(30)
  });

  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-02", "--dry-run"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org", TEST_SCRIPT_ROOT: scriptRoot },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(receiptsIn(result.stdout).map(({ date, tokens }) => ({ date, tokens })), [
    { date: "2026-01-02", tokens: 60 }
  ]);
  const requests = await stub.requests();
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ query }) => query.bucket_width === "1m" && query.limit === "1440"));
  assert.deepEqual(new Set(requests.map(({ path }) => path)), new Set([
    "/org/completions",
    "/org/embeddings",
    "/org/moderations"
  ]));
});

test("OpenAI keeps exact bucket widths for UTC, whole-hour, quarter-hour, and transitioning offsets", async () => {
  for (const [timezone, width, limit] of [
    ["UTC", "1d", "31"],
    ["America/Denver", "1h", "168"],
    ["Asia/Kathmandu", "1m", "1440"],
    ["Australia/Lord_Howe", "1m", "1440"]
  ]) {
    const cwd = await workdir();
    const scriptRoot = await localOpenAIExtractor(cwd, timezone);
    const empty = {
      [width]: [{ data: [], has_more: false }]
    };
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": empty,
      "/org/embeddings": empty,
      "/org/moderations": empty
    });
    const result = await run(
      "extract-openai-api.js",
      ["--since", "2026-01-01", "--dry-run"],
      { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org", TEST_SCRIPT_ROOT: scriptRoot },
      cwd,
      stub.preload
    );

    assert.equal(result.status, 0, `${timezone}: ${result.stderr}`);
    const requests = await stub.requests();
    assert.equal(requests.length, 3, timezone);
    assert.ok(requests.every(({ query }) => query.bucket_width === width && query.limit === limit), timezone);
  }
});

test("OpenAI retains zero-headline metadata and emits measured-zero activity", async () => {
  for (const mixedRows of [
    [
      { model: "headline", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 },
      { model: "cached", input_tokens: 1000, input_cached_tokens: 1000, output_tokens: 0, num_model_requests: 2 }
    ],
    [
      { model: "cached", input_tokens: 1000, input_cached_tokens: 1000, output_tokens: 0, num_model_requests: 2 },
      { model: "headline", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }
    ]
  ]) {
    const cwd = await workdir();
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": {
        "1d": [{ data: [
          { start_time: second(2), results: mixedRows },
          { start_time: second(3), results: [
            { model: "cached-only-a", input_tokens: 500, input_cached_tokens: 500, output_tokens: 0, num_model_requests: 2 },
            { model: "cached-only-b", input_tokens: 250, input_cached_tokens: 250, output_tokens: 0, num_model_requests: 3 }
          ] }
        ], has_more: false }]
      }
    });

    const result = await run(
      "extract-openai-api.js",
      ["--since", "2026-01-01", "--dry-run"],
      { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
      cwd,
      stub.preload
    );

    assert.equal(result.status, 0, result.stderr);
    const receipts = receiptsIn(result.stdout);
    assert.deepEqual(receipts.map(({ date, tokens, calls, models }) => ({ date, tokens, calls, models })), [
      { date: "2026-01-02", tokens: 100, calls: 3, models: ["cached", "headline"] },
      { date: "2026-01-03", tokens: 0, calls: 5, models: ["cached-only-a", "cached-only-b"] }
    ]);
    assert.match(receipts[0].provenance, /cached_input 1000 excluded/);
    assert.match(receipts[1].provenance, /cached_input 750 excluded/);
    assert.deepEqual(receipts.map(({ token_components }) => token_components), [
      { schema_version: 1, input_tokens: 1100, output_tokens: 0, cached_input_tokens: 1000 },
      { schema_version: 1, input_tokens: 750, output_tokens: 0, cached_input_tokens: 750 }
    ]);
    assert.deepEqual(validateReceiptSchema(receipts[1]), []);
  }
});

test("OpenAI omits token components whose provider coverage is incomplete", async () => {
  const cwd = await workdir();
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{ start_time: second(2), results: [
        { model: "complete", input_tokens: 100, input_cached_tokens: 20, output_tokens: 10, num_model_requests: 1 },
        { model: "partial", input_tokens: 50, num_model_requests: 1 }
      ] }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01", "--dry-run"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.deepEqual(receipt.token_components, { schema_version: 1, input_tokens: 150 });
  assert.deepEqual(validateReceiptSchema(receipt), []);
});

test("OpenAI preserves account-specific outputs across sequential and idempotent runs", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "org-a": openAIDecision("additive"),
    "org-b": openAIDecision("additive")
  });
  const runAccount = async (alias, tokens) => {
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": {
        "1d": [{ data: [{
          start_time: second(2),
          results: [{ model: "account-model", input_tokens: tokens, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
        }], has_more: false }]
      }
    });
    return run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      {
        OPENAI_ADMIN_KEY: KEY,
        OPENAI_ACCOUNT_ALIAS: alias,
        OPENAI_API_BASE_URL: "https://fixture.invalid/org"
      },
      cwd,
      stub.preload
    );
  };

  assert.equal((await runAccount("org-a", 100)).status, 0);
  assert.equal((await runAccount("org-b", 200)).status, 0);
  assert.equal((await runAccount("org-a", 100)).status, 0);

  const receiptDir = join(cwd, "scratch", "receipts");
  assert.deepEqual((await readdir(receiptDir)).sort(), [
    `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`,
    `openai-api-${scopedAccount("org-b", "scope-org-b")}.jsonl`
  ].sort());
  const receipts = [];
  for (const file of await readdir(receiptDir)) {
    receipts.push(...receiptsIn(await readFile(join(receiptDir, file), "utf8")));
  }
  assert.deepEqual(receipts.map(({ account_alias, tokens }) => ({ account_alias, tokens })), [
    { account_alias: scopedAccount("org-a", "scope-org-a"), tokens: 100 },
    { account_alias: scopedAccount("org-b", "scope-org-b"), tokens: 200 }
  ]);
});

test("OpenAI requires an exact configured organization-scope binding before network access", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "primary-scope-a": {
      account_alias: "primary",
      organization_scope: "scope-a",
      ...openAIDecision("additive")
    }
  });
  const stub = await stubbedUsagePages(cwd, {});

  for (const [scope, pattern] of [
    ["", /OPENAI_ORGANIZATION_SCOPE.*required/i],
    ["scope-b", /does not match a configured account binding/i]
  ]) {
    const result = await run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      {
        OPENAI_ADMIN_KEY: KEY,
        OPENAI_ACCOUNT_ALIAS: "primary",
        OPENAI_ORGANIZATION_SCOPE: scope,
        OPENAI_API_BASE_URL: "https://fixture.invalid/org"
      },
      cwd,
      stub.preload
    );
    assert.equal(result.status, 64);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await stub.requests(), []);
});

test("OpenAI isolates two organization scopes that share one display alias", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "primary-scope-a": {
      account_alias: "primary",
      organization_scope: "scope-a",
      ...openAIDecision("additive")
    },
    "primary-scope-b": {
      account_alias: "primary",
      organization_scope: "scope-b",
      ...openAIDecision("additive")
    }
  });
  const runScope = async (scope, tokens) => {
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": {
        "1d": [{ data: [{
          start_time: second(2),
          results: [{ model: "account-model", input_tokens: tokens, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
        }], has_more: false }]
      }
    });
    return run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      {
        OPENAI_ADMIN_KEY: KEY,
        OPENAI_ACCOUNT_ALIAS: "primary",
        OPENAI_ORGANIZATION_SCOPE: scope,
        OPENAI_API_BASE_URL: "https://fixture.invalid/org"
      },
      cwd,
      stub.preload
    );
  };

  assert.equal((await runScope("scope-a", 100)).status, 0);
  assert.equal((await runScope("scope-b", 200)).status, 0);

  const identities = [scopedAccount("primary", "scope-a"), scopedAccount("primary", "scope-b")].sort();
  const receiptDir = join(cwd, "scratch", "receipts");
  assert.deepEqual(
    await readdir(receiptDir),
    identities.map((identity) => `openai-api-${identity}.jsonl`)
  );
  const receipts = [];
  for (const identity of identities) {
    receipts.push(...receiptsIn(await readFile(join(receiptDir, `openai-api-${identity}.jsonl`), "utf8")));
  }
  assert.deepEqual(
    receipts.map(({ account_alias, tokens }) => ({ account_alias, tokens })),
    identities.map((account_alias) => ({
      account_alias,
      tokens: account_alias === scopedAccount("primary", "scope-a") ? 100 : 200
    }))
  );
  assert.equal(new Set(receipts.map(({ snapshot_key }) => snapshot_key)).size, 2);
});

test("OpenAI rejects one organization scope bound to two display aliases before network access", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "org-a": {
      account_alias: "org-a",
      organization_scope: "shared-scope",
      ...openAIDecision("additive")
    },
    "org-b": {
      account_alias: "org-b",
      organization_scope: "shared-scope",
      ...openAIDecision("additive")
    }
  });
  const stub = await stubbedUsagePages(cwd, {});

  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_ACCOUNT_ALIAS: "org-a",
      OPENAI_ORGANIZATION_SCOPE: "shared-scope",
      OPENAI_API_BASE_URL: "https://fixture.invalid/org"
    },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /duplicates another organization scope/);
  assert.deepEqual(await stub.requests(), []);
});

test("OpenAI rejects alias collisions and preserves another account through a failed run", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, {
    "org-a": openAIDecision("additive"),
    "org-b": openAIDecision("additive")
  });
  const goodStub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "account-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const good = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_ACCOUNT_ALIAS: "org-a", OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    goodStub.preload
  );
  assert.equal(good.status, 0, good.stderr);
  const accountA = join(
    cwd,
    "scratch",
    "receipts",
    `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`
  );
  const original = await readFile(accountA, "utf8");

  const collision = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_ACCOUNT_ALIAS: "Org A" },
    cwd
  );
  assert.equal(collision.status, 64);
  assert.match(collision.stderr, /account alias must already be a lowercase filesystem-safe slug/);

  const failed = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_ACCOUNT_ALIAS: "org-b" },
    cwd,
    await stubbedFetch(cwd, "SOME_OTHER_ERROR")
  );
  assert.equal(failed.status, 1);
  assert.equal(await readFile(accountA, "utf8"), original);
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), [
    `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`
  ]);
});

test("OpenAI migrates only a fully covered matching legacy default output after a successful write", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, { "org-a": openAIDecision("additive") });
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(receiptDir, { recursive: true });
  await writeFile(join(receiptDir, "openai-api.jsonl"), JSON.stringify({
    schema_version: 2,
    date: "2026-01-02",
    timezone: "UTC",
    source: "openai_api",
    provider: "openai",
    surface: "api",
    account_alias: "org-a",
    origin: "account/openai",
    interval: { start: "2026-01-02", end: "2026-01-02" },
    snapshot_key: "openai_api:org-a:2026-01-02",
    authority: "provider",
    models: ["legacy-model"],
    tokens: 10,
    calls: 1,
    fidelity: "exact",
    token_components: {
      schema_version: 1,
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 0
    }
  }) + "\n");
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "account-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_ACCOUNT_ALIAS: "org-a", OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 0, result.stderr);
  const currentOutput = `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`;
  assert.deepEqual(await readdir(receiptDir), [currentOutput]);
  assert.match(result.stdout, /Migrated matching legacy OpenAI API output/);
  assert.deepEqual(
    receiptsIn(await readFile(join(receiptDir, currentOutput), "utf8")).map(({ date, tokens }) => ({ date, tokens })),
    [{ date: "2026-01-02", tokens: 100 }]
  );

  const uncoveredLegacy = {
    ...receiptsIn(await readFile(join(receiptDir, currentOutput), "utf8"))[0],
    account_alias: "org-a",
    date: "2026-01-01",
    interval: { start: "2026-01-01", end: "2026-01-01" },
    snapshot_key: "openai_api:org-a:2026-01-01",
    tokens: 10
  };
  await writeFile(join(receiptDir, "openai-api.jsonl"), JSON.stringify(uncoveredLegacy) + "\n");
  const retained = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    { OPENAI_ADMIN_KEY: KEY, OPENAI_ACCOUNT_ALIAS: "org-a", OPENAI_API_BASE_URL: "https://fixture.invalid/org" },
    cwd,
    stub.preload
  );
  assert.equal(retained.status, 0, retained.stderr);
  assert.match(retained.stderr, /contains snapshots outside this run; it was retained/);
  assert.deepEqual((await readdir(receiptDir)).sort(), [currentOutput, "openai-api.jsonl"].sort());
});

test("OpenAI restores legacy evidence when scoped migration publication fails", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, { "org-a": openAIDecision("additive") });
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(receiptDir, { recursive: true });
  const legacyPath = join(receiptDir, "openai-api.jsonl");
  const legacyText = JSON.stringify({
    schema_version: 2,
    date: "2026-01-02",
    timezone: "UTC",
    source: "openai_api",
    provider: "openai",
    surface: "api",
    account_alias: "org-a",
    origin: "account/openai",
    interval: { start: "2026-01-02", end: "2026-01-02" },
    snapshot_key: "openai_api:org-a:2026-01-02",
    authority: "provider",
    models: ["legacy-model"],
    tokens: 10,
    calls: 1,
    fidelity: "exact"
  }) + "\n";
  await writeFile(legacyPath, legacyText);
  const scopedPath = join(
    receiptDir,
    `openai-api-${scopedAccount("org-a", "scope-org-a")}.jsonl`
  );
  await mkdir(scopedPath);
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "account-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });

  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_ACCOUNT_ALIAS: "org-a",
      OPENAI_API_BASE_URL: "https://fixture.invalid/org"
    },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 1, result.stderr);
  await rm(scopedPath, { recursive: true });
  assert.equal(await readFile(legacyPath, "utf8"), legacyText);
  assert.equal(
    await readFile(join(cwd, "scratch", "reconcile", "openai-api.previous-default.jsonl"), "utf8"),
    legacyText
  );
  assert.deepEqual(await readdir(receiptDir), ["openai-api.jsonl"]);
});

test("OpenAI fails closed when legacy default evidence cannot be read", async () => {
  const cwd = await workdir();
  await writeOpenAIConfig(cwd, { "org-a": openAIDecision("additive") });
  const receiptDir = join(cwd, "scratch", "receipts");
  await mkdir(join(receiptDir, "openai-api.jsonl"), { recursive: true });
  const stub = await stubbedUsagePages(cwd, {
    "/org/completions": {
      "1d": [{ data: [{
        start_time: second(2),
        results: [{ model: "account-model", input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }]
      }], has_more: false }]
    }
  });
  const result = await run(
    "extract-openai-api.js",
    ["--since", "2026-01-01"],
    {
      OPENAI_ADMIN_KEY: KEY,
      OPENAI_ACCOUNT_ALIAS: "org-a",
      OPENAI_API_BASE_URL: "https://fixture.invalid/org"
    },
    cwd,
    stub.preload
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /legacy OpenAI API output could not be read.*retained/i);
  assert.deepEqual(await readdir(receiptDir), ["openai-api.jsonl"]);
});

test("OpenAI retains legacy evidence when current tokens, calls, or components regress", async () => {
  const cases = [
    {
      name: "tokens",
      legacy: { tokens: 100, calls: 1 },
      current: { input_tokens: 10, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }
    },
    {
      name: "calls",
      legacy: { tokens: 10, calls: 5 },
      current: { input_tokens: 100, input_cached_tokens: 0, output_tokens: 0, num_model_requests: 1 }
    },
    {
      name: "components",
      legacy: {
        tokens: 10,
        calls: 1,
        token_components: {
          schema_version: 1,
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 0
        }
      },
      current: { input_tokens: 100, output_tokens: 0, num_model_requests: 1 }
    }
  ];

  for (const { name, legacy: legacyValues, current } of cases) {
    const cwd = await workdir();
    await writeOpenAIConfig(cwd, { "org-a": openAIDecision("additive") });
    const receiptDir = join(cwd, "scratch", "receipts");
    await mkdir(receiptDir, { recursive: true });
    const legacyPath = join(receiptDir, "openai-api.jsonl");
    await writeFile(legacyPath, JSON.stringify({
      schema_version: 2,
      date: "2026-01-02",
      timezone: "UTC",
      source: "openai_api",
      provider: "openai",
      surface: "api",
      account_alias: "org-a",
      origin: "account/openai",
      interval: { start: "2026-01-02", end: "2026-01-02" },
      snapshot_key: "openai_api:org-a:2026-01-02",
      authority: "provider",
      fidelity: "exact",
      ...legacyValues
    }) + "\n");
    const stub = await stubbedUsagePages(cwd, {
      "/org/completions": {
        "1d": [{ data: [{ start_time: second(2), results: [{ model: name, ...current }] }], has_more: false }]
      }
    });
    const result = await run(
      "extract-openai-api.js",
      ["--since", "2026-01-01"],
      {
        OPENAI_ADMIN_KEY: KEY,
        OPENAI_ACCOUNT_ALIAS: "org-a",
        OPENAI_API_BASE_URL: "https://fixture.invalid/org"
      },
      cwd,
      stub.preload
    );

    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /current evidence does not equal or dominate it; it was retained/i, name);
    assert.equal(await readFile(legacyPath, "utf8").then(() => true), true, name);
    assert.deepEqual(await readdir(receiptDir), ["openai-api.jsonl"], name);
  }
});

test("without a key, each extractor skips cleanly and asks nothing of the provider", async () => {
  const cwd = await workdir();
  const anthropic = await run("extract-claude-api.js", ["--dry-run"], {}, cwd);
  assert.equal(anthropic.status, 0);
  assert.match(anthropic.stdout, /ANTHROPIC_ADMIN_KEY not set/);
  const openai = await run("extract-openai-api.js", ["--dry-run"], {}, cwd);
  assert.equal(openai.status, 0);
  assert.match(openai.stdout, /OPENAI_ADMIN_KEY not set/);
});

// A provider that cannot be reached is unknown (exit 3), distinct from an
// ordinary failure (exit 1). fetch is stubbed before the extractor loads.
const stubbedFetch = async (cwd, code) => {
  const path = join(cwd, "fetch-stub.mjs");
  await writeFile(path, `globalThis.fetch = async () => { const e = new TypeError("fetch failed"); e.cause = { code: ${JSON.stringify(code)} }; throw e; };\n`);
  return ["--import", path];
};

for (const [script, keyName, host] of [
  ["extract-claude-api.js", "ANTHROPIC_ADMIN_KEY", /api\.anthropic\.com/],
  ["extract-openai-api.js", "OPENAI_ADMIN_KEY", /api\.openai\.com/]
]) {
  test(`${script} classifies transport failures without leaking the key or the query`, async () => {
    for (const [code, status] of [["ENOTFOUND", 3], ["UND_ERR_CONNECT_TIMEOUT", 3], ["SOME_OTHER_ERROR", 1]]) {
      const cwd = await workdir("additive");
      const result = await run(script, ["--dry-run"], { [keyName]: KEY }, cwd, await stubbedFetch(cwd, code));
      assert.equal(result.status, status, `${code}: ${result.stderr}`);
      if (status === 3) {
        assert.match(result.stderr, /unreachable/);
        assert.match(result.stderr, host);
      }
      assert.doesNotMatch(result.stderr, new RegExp(KEY));
      assert.doesNotMatch(result.stderr, /\?/, "never the URL's query string");
      assert.equal(receiptsIn(result.stdout).length, 0);
    }
  });
}
