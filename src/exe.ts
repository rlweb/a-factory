import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";

// ponytail: opencode is always started on this fixed port on every VM — no per-VM port
// negotiation. Simplest thing that works for one agent per VM; revisit if VMs ever run more.
export const OPENCODE_PORT = 4096;

let keyPath: string | undefined;

/** Writes the ssh-exe-private-key input (an SSH private key) to disk once, for use as -i on
 * every `ssh exe.dev` call. exe.dev's non-interactive CI auth mechanism is unconfirmed — see
 * the plan's open items; this assumes a deploy-key-style credential. */
function identity(): string[] {
  if (!keyPath) {
    const key = core.getInput("ssh-exe-private-key", { required: true });
    const dir = mkdtempSync(join(tmpdir(), "exe-dev-"));
    keyPath = join(dir, "id");
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  return ["-i", keyPath, "-o", "StrictHostKeyChecking=accept-new"];
}

function ssh(args: string[]): string {
  return execFileSync("ssh", [...identity(), ...args], { encoding: "utf8" });
}

export function vmName(issueNumber: number): string {
  const prefix = core.getInput("vm-name-prefix") || "a-factory";
  return `${prefix}-issue-${issueNumber}`;
}

export function vmUrl(name: string): string {
  return `https://${name}.exe.xyz:${OPENCODE_PORT}`;
}

/** Creates a VM and starts opencode on it in server mode, backgrounded so the SSH call
 * returns once it's launched rather than blocking for the VM's lifetime. `env` is exported
 * into the VM's shell so both the opencode server and the shell commands the agent runs
 * (git clone/push) can see it — e.g. GITHUB_TOKEN, OPENCODE_API_KEY. */
export function createVm(name: string, env: Record<string, string>): void {
  const image = core.getInput("vm-image");
  const cpu = core.getInput("vm-cpu");
  const disk = core.getInput("vm-disk");
  const memory = core.getInput("vm-memory");
  const tags = core
    .getInput("vm-tag")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const vmEnv = core
    .getInput("vm-env")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  core.info(`exe: creating VM ${name}${image ? ` (image ${image})` : ""}`);
  ssh([
    "exe.dev",
    "new",
    "--name",
    name,
    "--command",
    "none",
    ...(image ? ["--image", image] : []),
    ...(cpu ? ["--cpu", cpu] : []),
    ...(disk ? ["--disk", disk] : []),
    ...(memory ? ["--memory", memory] : []),
    ...tags.flatMap((t) => ["--tag", t]),
    ...vmEnv.flatMap((e) => ["--env", e]),
    "--no-email",
  ]);
  const exportEnv = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)};`)
    .join(" ");
  ssh([
    `${name}.exe.xyz`,
    `${exportEnv} nohup opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 >/tmp/opencode.log 2>&1 </dev/null & disown`,
  ]);
}

/** Deletes a VM. Swallows "doesn't exist" failures — callers use this as a safety-net
 * cleanup that may race with (or repeat) an earlier teardown. */
export function destroyVm(name: string): void {
  try {
    core.info(`exe: destroying VM ${name}`);
    ssh(["exe.dev", "rm", name]);
  } catch (e) {
    core.warning(`exe: destroy ${name} failed (already gone?): ${(e as Error).message}`);
  }
}
