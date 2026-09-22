import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function bootIdentity(platform = process.platform) {
  if (platform === "linux") {
    try {
      return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null;
    } catch { // honesty-ok: unavailable boot identity blocks acquisition and recovery.
      return null;
    }
  }
  if (platform === "darwin") {
    const result = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    try {
      const marker = await stat("/var/run/com.apple.DumpPanic.finishedThisBoot");
      return `boot-marker:${marker.dev}:${marker.ino}:${marker.birthtimeMs}:${marker.mtimeMs}`;
    } catch { // honesty-ok: absent fallback identity remains unknown; it never establishes a dead owner.
      return null;
    }
  }
  return null;
}

export async function processIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown", detail: "invalid pid" };
  if (platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startId = fields[19];
      return startId ? { state: "active", startId } : { state: "unknown", detail: "missing start id" };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return { state: "dead" };
      return { state: "unknown", detail: "process identity unreadable" };
    }
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { state: "dead" };
    if (error.code !== "EPERM") return { state: "unknown", detail: "process liveness unknown" };
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  if (result.status === 0 && result.stdout.trim()) {
    return { state: "active", startId: result.stdout.trim() };
  }
  return { state: "unknown", detail: "process start identity unavailable" };
}

export async function processGroupState(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    return { state: "unknown", detail: "invalid process group id" };
  }
  try {
    process.kill(-processGroupId, 0);
    return { state: "active" };
  } catch (error) {
    if (error.code === "ESRCH") return { state: "dead" };
    if (error.code === "EPERM") return { state: "active" };
    return { state: "unknown", detail: "process group liveness unknown" };
  }
}

const stateForIdentity = async (identity, inspectProcess) => {
  if (!identity || !Number.isSafeInteger(identity.pid) || typeof identity.start_id !== "string") {
    return { state: "unknown", detail: "owner identity is incomplete" };
  }
  const observed = await inspectProcess(identity.pid);
  if (observed.state !== "active") return observed;
  return observed.startId === identity.start_id
    ? { state: "active" }
    : { state: "dead", detail: "pid was reused by a different process start" };
};

export async function classifyProcessLease(owner, current) {
  if (!owner || owner.schema_version !== 1 || typeof owner.lease_id !== "string") {
    return { state: "unknown", detail: "legacy or malformed owner record" };
  }
  if (owner.hostname !== current.hostname) {
    return { state: "unknown", detail: "lock belongs to another host" };
  }
  if (!current.bootId || typeof owner.boot_id !== "string") {
    return { state: "unknown", detail: "boot identity is unavailable" };
  }
  if (owner.boot_id !== current.bootId) {
    return { state: "abandoned", detail: "owner belongs to an earlier boot" };
  }

  const supervisor = await stateForIdentity(owner.supervisor, current.inspectProcess);
  let child = { state: "dead" };
  if (owner.child?.state === "pending") {
    child = { state: "unknown", detail: "child launch was not fully recorded" };
  } else if (owner.child?.state === "running") {
    child = await stateForIdentity(owner.child, current.inspectProcess);
    if (child.state === "dead" && Number.isSafeInteger(owner.child.process_group_id)) {
      const inspectGroup = current.inspectProcessGroup ?? processGroupState;
      const group = await inspectGroup(owner.child.process_group_id);
      if (group.state === "active") {
        child = { state: "active", detail: "supervised child process group still has members" };
      } else if (group.state === "unknown") {
        child = group;
      }
    }
  } else if (owner.child != null) {
    child = { state: "unknown", detail: "child state is unrecognized" };
  }

  if (supervisor.state === "active" || child.state === "active") {
    return { state: "active", supervisor, child };
  }
  if (supervisor.state === "unknown" || child.state === "unknown") {
    return {
      state: "unknown",
      detail: [supervisor.detail, child.detail].filter(Boolean).join("; "),
      supervisor,
      child
    };
  }
  return { state: "abandoned", detail: "recorded supervisor and child are no longer running" };
}

const environment = async (overrides = {}) => ({
  hostname: overrides.hostname ?? hostname(),
  bootId: overrides.bootId ?? await bootIdentity(),
  inspectProcess: overrides.inspectProcess ?? processIdentity,
  inspectProcessGroup: overrides.inspectProcessGroup ?? processGroupState
});

export async function inspectProcessLease(lockDir, options = {}) {
  let ownerText;
  try {
    ownerText = await readFile(join(lockDir, "owner.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        await readFile(lockDir);
      } catch (directoryError) {
        if (directoryError.code === "ENOENT") return { state: "missing" };
      }
      return { state: "unknown", detail: "lock has no readable owner record" };
    }
    return { state: "unknown", detail: "lock owner record is unreadable" };
  }
  let owner;
  try {
    owner = JSON.parse(ownerText);
  } catch { // honesty-ok: malformed ownership is reported as unknown and blocks reclamation.
    return { state: "unknown", detail: "lock owner record is not valid JSON", ownerText };
  }
  return {
    ...await classifyProcessLease(owner, await environment(options.environment)),
    owner,
    ownerText
  };
}

const atomicOwnerWrite = async (lockDir, owner) => {
  const path = join(lockDir, "owner.json");
  const temporary = join(lockDir, `.owner.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
};

const ownerRecord = (current, supervisor) => {
  const startedAt = new Date().toISOString();
  return {
    schema_version: 1,
    lease_id: randomUUID(),
    hostname: current.hostname,
    boot_id: current.bootId,
    created_at: startedAt,
    started_at: startedAt,
    supervisor: { pid: process.pid, start_id: supervisor.startId },
    child: null
  };
};

const acquireSerializationClaim = async (lockDir, current, supervisor, label) => {
  const claimDir = `${lockDir}.claim`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(claimDir, { mode: 0o700 });
      const claimOwner = ownerRecord(current, supervisor);
      await writeFile(join(claimDir, "owner.json"), `${JSON.stringify(claimOwner, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      return async () => {
        const recorded = JSON.parse(await readFile(join(claimDir, "owner.json"), "utf8"));
        if (recorded.lease_id !== claimOwner.lease_id) {
          throw new Error(`${label} acquisition claim ownership changed`);
        }
        await unlink(join(claimDir, "owner.json"));
        await rmdir(claimDir);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const observed = await inspectProcessLease(claimDir, {
        environment: {
          hostname: current.hostname,
          bootId: current.bootId,
          inspectProcess: current.inspectProcess,
          inspectProcessGroup: current.inspectProcessGroup
        }
      });
      if (observed.state === "active" || observed.state === "missing") {
        await delay(10);
        continue;
      }
      // mkdir and the exclusive owner write are separate filesystem operations.
      // Give a contender a bounded chance to finish that write, while leaving a
      // genuinely orphaned ownerless claim in place for manual recovery.
      if (
        observed.state === "unknown" &&
        observed.detail === "lock has no readable owner record" &&
        attempt < 49
      ) {
        await delay(10);
        continue;
      }
      throw new Error(
        `${label} acquisition claim is ${observed.state} at ${claimDir}: ${observed.detail ?? "unknown owner"}. ` +
          "Inspect the claim owner and remove it only after confirming the acquisition process is gone."
      );
    }
  }
  throw new Error(`${label} acquisition claim remained active at ${claimDir}`);
};

export async function acquireProcessLease(lockDir, options = {}) {
  const label = options.label ?? basename(lockDir);
  const current = await environment(options.environment);
  const supervisor = await current.inspectProcess(process.pid);
  if (!current.bootId || supervisor.state !== "active" || !supervisor.startId) {
    throw new Error(`${label} cannot establish this process's boot and start identity`);
  }
  await mkdir(dirname(lockDir), { recursive: true });
  const releaseClaim = await acquireSerializationClaim(lockDir, current, supervisor, label);
  let owner = ownerRecord(current, supervisor);
  try {
    const observed = await inspectProcessLease(lockDir, { environment: options.environment });
    if (observed.state === "active") {
      throw new Error(`${label} lock already held and active at ${lockDir}`);
    }
    if (observed.state === "unknown") {
      throw new Error(
        `${label} ownership is unknown at ${lockDir}: ${observed.detail}. ` +
          "Inspect owner.json and remove the lock only after confirming no supervisor or child survives."
      );
    }
    if (observed.state === "abandoned") await rm(lockDir, { recursive: true });
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    throw error;
  } finally {
    await releaseClaim();
  }

  const update = async (child) => {
    owner = { ...owner, child };
    await atomicOwnerWrite(lockDir, owner);
  };
  let released = false;
  const release = async () => {
    if (released) return;
    if (owner.child) throw new Error(`${label} cannot release while child state is recorded`);
    const releaseSerialization = await acquireSerializationClaim(lockDir, current, supervisor, label);
    try {
      const recorded = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8"));
      if (recorded.lease_id !== owner.lease_id) throw new Error(`${label} ownership changed before release`);
      await unlink(join(lockDir, "owner.json"));
      await rmdir(lockDir);
      released = true;
    } finally {
      await releaseSerialization();
    }
  };

  return {
    lockDir,
    owner: () => structuredClone(owner),
    markChildPending: (command) => update({ state: "pending", command }),
    markChildRunning: (child) => update({ state: "running", ...child }),
    clearChild: () => update(null),
    inspectProcess: current.inspectProcess,
    inspectProcessGroup: current.inspectProcessGroup,
    release
  };
}

export async function runLeaseCommand(lease, command, args, options = {}) {
  await lease.markChildPending(basename(command));
  let child;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
      detached: options.detached ?? true
    });
  } catch (error) {
    await lease.clearChild();
    throw error;
  }
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({
      error,
      status: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.once("close", (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
  if (!Number.isSafeInteger(child.pid)) {
    const result = await closed;
    await lease.clearChild();
    throw result.error ?? new Error("child process did not receive a process id");
  }

  let identity;
  try {
    identity = await lease.inspectProcess(child.pid);
    for (let attempt = 0; identity.state === "unknown" && attempt < 4; attempt += 1) {
      await delay(10);
      identity = await lease.inspectProcess(child.pid);
    }
  } catch (error) {
    throw new Error(`child process identity check failed; lease remains pending: ${error.message}`);
  }

  if (identity.state === "active" && identity.startId) {
    try {
      await lease.markChildRunning({
        pid: child.pid,
        start_id: identity.startId,
        process_group_id: options.detached === false ? null : child.pid
      });
    } catch (error) {
      throw new Error(`child process identity could not be recorded; lease remains protective: ${error.message}`);
    }
  }
  const result = await closed;
  if (options.detached !== false) {
    const group = await lease.inspectProcessGroup(child.pid);
    if (group.state === "active") {
      throw new Error("supervised command leader exited while child process-group members survive");
    }
    if (group.state !== "dead") {
      throw new Error("supervised command process-group liveness is unknown");
    }
  } else if (result.error) {
    const finalIdentity = await lease.inspectProcess(child.pid);
    if (finalIdentity.state !== "dead") {
      throw new Error("supervised command failed while process liveness remains active or unknown");
    }
  }
  await lease.clearChild();
  if (result.error) throw result.error;
  return result;
}
