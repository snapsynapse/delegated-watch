import { createHash } from "node:crypto";
import {
  mkdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { acquireProcessLease } from "./process-lease.js";

export const OPENAI_SOURCES = new Set(["codex", "chatgpt", "openai_api"]);

export const safeAlias = (value, fallback) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
};
export const machineAlias = () => {
  if (process.env.TOKEN_DASHBOARD_MACHINE_ALIAS) {
    return safeAlias(process.env.TOKEN_DASHBOARD_MACHINE_ALIAS, "machine");
  }
  const digest = createHash("sha256").update(hostname()).digest("hex").slice(0, 10);
  return `machine-${digest}`;
};

export const accountAlias = (provider = "openai") =>
  safeAlias(
    process.env[`${provider.toUpperCase()}_ACCOUNT_ALIAS`] ??
      process.env.TOKEN_DASHBOARD_ACCOUNT_ALIAS,
    "primary"
  );

export const atomicWriteText = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
};

export const acquireOpenAILock = async (
  lockDir = "scratch/openai-refresh.lock"
) => {
  const lease = await acquireProcessLease(lockDir, { label: "OpenAI refresh" });
  const release = lease.release;
  release.lease = lease;
  return release;
};
