// Local dashboard preview. It serves exactly the generated dashboard, rebuilding
// it for each document request so the browser and shipped artifact share bytes.
//
// Usage:
//   node scripts/dev-server.js     (PORT and HOST respected; loopback only)

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
// The built page lives where config/site.json says (build_output), which is
// docs2B/ in the private checkout and docs/ in the public repository. A missing
// site.json means the historical default; any other read failure surfaces.
const DEFAULT_BUILD_OUTPUT = "docs2B/index.html";
const buildOutput = await readFile(join(root, "config/site.json"), "utf8").then(
  (text) => JSON.parse(text).build_output ?? DEFAULT_BUILD_OUTPUT,
  (error) => { if (error.code === "ENOENT") return DEFAULT_BUILD_OUTPUT; throw error; }
);
const BUILT = join(root, buildOutput);
const BUILD_DIR = dirname(BUILT);
const supportedHosts = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "[::1]"]
]);

if (!supportedHosts.has(host)) {
  throw new Error("HOST must be one of: 127.0.0.1, ::1.");
}
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be an integer from 0 through 65535.");
}

const expectedHost = supportedHosts.get(host);
const requestHost = (value) => {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch { // honesty-ok: malformed Host is rejected with 421, never treated as trusted.
    return null;
  }
};

const rebuild = async () => {
  const started = Date.now();
  await run(process.execPath, [join(root, "scripts", "build.js")], { cwd: root });
  return Date.now() - started;
};

const assertSafeBuildDirectory = async () => {
  let metadata;
  try {
    metadata = await lstat(BUILD_DIR);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("dashboard build directory is not a real directory");
  }
};

const readDashboard = async () => {
  await assertSafeBuildDirectory();
  const metadata = await lstat(BUILT);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("dashboard artifact is not a regular file");
  }
  const handle = await open(BUILT, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const server = createServer(async (request, response) => {
  const hostHeader = requestHost(request.headers.host);
  if (hostHeader !== expectedHost) {
    response.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
    response.end("Unexpected Host header.");
    return;
  }
  if (!request.url || !["GET", "HEAD"].includes(request.method || "")) {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed.");
    return;
  }

  let url;
  try {
    url = new URL(request.url, `http://${expectedHost}`);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid request target.");
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }

  try {
    await assertSafeBuildDirectory();
    const ms = await rebuild();
    const page = await readDashboard();
    console.log(`rebuilt in ${ms}ms → ${url.pathname}`);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": page.length
    });
    response.end(request.method === "HEAD" ? undefined : page);
  } catch (error) {
    console.error(`Dashboard rebuild or read failed: ${error instanceof Error ? error.message : String(error)}`);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Dashboard build failed.");
  }
});

server.once("error", (error) => {
  console.error(`Could not bind dev server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Delegated.watch dev server on http://${expectedHost}:${listeningPort}`);
  console.log("Serving only the generated dashboard; every document request rebuilds it.");
});
