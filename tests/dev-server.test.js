import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");

const requestPage = (port, path, host = `127.0.0.1:${port}`) => new Promise((resolveRequest, reject) => {
  const client = request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolveRequest({ status: response.statusCode, body }));
  });
  client.on("error", reject);
  client.end();
});

const waitForServer = (child) => new Promise((resolveReady, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 5_000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    const match = output.match(/127\.0\.0\.1:(\d+)/);
    if (match) {
      clearTimeout(timer);
      resolveReady(Number(match[1]));
    }
  });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`server exited ${code}: ${output}`)));
});

const makeServerRoot = async (mode = "regular") => {
  const root = await mkdtemp(join(tmpdir(), "delegated-watch-dev-server-"));
  await mkdir(join(root, "scripts"));
  await cp(join(repo, "scripts", "dev-server.js"), join(root, "scripts", "dev-server.js"));
  const build = mode === "symlink"
    ? `import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
       await mkdir("docs2B", { recursive: true });
       await writeFile("private.html", "private");
       await rm("docs2B/index.html", { force: true });
       await symlink("../private.html", "docs2B/index.html");`
    : mode === "directory"
      ? `import { mkdir, rm } from "node:fs/promises";
         await mkdir("docs2B", { recursive: true });
         await rm("docs2B/index.html", { force: true, recursive: true });
         await mkdir("docs2B/index.html");`
      : mode === "unreadable"
        ? `import { chmod, mkdir, writeFile } from "node:fs/promises";
           await mkdir("docs2B", { recursive: true });
           await writeFile("docs2B/index.html", "private");
           await chmod("docs2B/index.html", 0o000);`
    : mode === "broken"
      ? "process.exit(1);"
      : `import { mkdir, writeFile } from "node:fs/promises";
         await mkdir("docs2B", { recursive: true });
         await writeFile("docs2B/index.html", "<main>synthetic dashboard</main>");`;
  await writeFile(join(root, "scripts", "build.js"), build);
  if (mode === "parent-symlink") {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "sentinel.txt"), "do not overwrite");
    await symlink("outside", join(root, "docs2B"));
  }
  return root;
};

const withServer = async (root, fn) => {
  const child = spawn(process.execPath, [join(root, "scripts", "dev-server.js")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const port = await waitForServer(child);
    await fn(port);
  } finally {
    child.kill();
  }
};

test("dev server exposes only the generated dashboard and rejects hostile Host headers", async () => {
  const root = await makeServerRoot();
  await withServer(root, async (port) => {
    assert.deepEqual(await requestPage(port, "/"), {
      status: 200,
      body: "<main>synthetic dashboard</main>"
    });
    assert.equal((await requestPage(port, "/src/app.js")).status, 404);
    assert.equal((await requestPage(port, "/docs2B/index.html")).status, 404);
    assert.equal((await requestPage(port, "/private.html")).status, 404);
    assert.equal((await requestPage(port, "/", "rebind.invalid")).status, 421);
  });
});

test("dev server contains broken, unreadable, directory, and symlink artifacts without terminating", async () => {
  for (const mode of ["symlink", "directory", "unreadable", "broken"]) {
    const root = await makeServerRoot(mode);
    await withServer(root, async (port) => {
      const response = await requestPage(port, "/");
      assert.equal(response.status, 500);
      assert.equal(response.body, "Dashboard build failed.");
      assert.equal((await requestPage(port, "/private.html")).status, 404);
    });
  }
});

test("dev server refuses a symlinked build directory before the build can write through it", async () => {
  const root = await makeServerRoot("parent-symlink");
  const sentinel = join(root, "outside", "sentinel.txt");
  await withServer(root, async (port) => {
    const response = await requestPage(port, "/");
    assert.equal(response.status, 500);
    assert.equal(response.body, "Dashboard build failed.");
  });
  assert.equal(await readFile(sentinel, "utf8"), "do not overwrite");
});

test("dev server fails closed before listening for unsupported bindings", async () => {
  const root = await makeServerRoot();
  const result = spawnSync(process.execPath, [join(root, "scripts", "dev-server.js")], {
    cwd: root,
    env: { ...process.env, HOST: "0.0.0.0", PORT: "0" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOST must be one of/);
});
