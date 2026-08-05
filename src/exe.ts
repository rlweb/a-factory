import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";

// pi-harness runs as a systemd service on the VM, listening on this fixed port.
// No per-VM negotiation needed — one harness per VM.
export const HARNESS_PORT = 4096;

// exe.dev's control plane and every VM behind *.exe.xyz share one RSA host key. Pinned here so
// ssh verifies against a known key instead of trusting/writing on first sight (accept-new) —
// which is what produced the "Permanently added ... to the list of known hosts" warnings.
// Update this if exe.dev ever rotates their host key.
const PINNED_HOSTS = "exe.dev,*.exe.xyz ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDEKtEcRW8OBtro5B/MG+EaisD+ZVwwHFa5m7M8wFwBlMmPJJssY+1aGBRW3b9InAeCnTU2Kt7gazqbg/9od1KnK6x5piQNVQZ4C/lrjsC2ScBrOydnw9ry9G2+voFCAk+dQGabIrIT6gqqDJNOqxgFiG/lA3Xx6KwpfwI2BH5f3ab2fHCR2BGAC5jlB2RJXPgly80hMxYEHqexhJxYRwC+deeLrQSG795we9rSzPmdz58t9+9jLTKkyyqWKe/hmBvty1AYrEmRsefu6/TUrIGi/UWJfa+RBIQtFgWqN6xT1F6rRwELeVOfwwr5tZbsmgWY5frZU3EOtVWcF7Ve3gfL";

let keyPath: string | undefined;
let knownHostsPath: string | undefined;

/** Writes the ssh-exe-private-key input (an SSH private key) to disk once, for use as -i on
 *  every `ssh exe.dev` call. */
function identity(): string[] {
  if (!keyPath) {
    const key = core.getInput("ssh-exe-private-key", { required: true });
    const dir = mkdtempSync(join(tmpdir(), "exe-dev-"));
    keyPath = join(dir, "id");
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  return ["-i", keyPath];
}

/** Points ssh at a known_hosts file seeded with the pinned exe.dev/VM host key and enforces it
 *  via StrictHostKeyChecking=yes, so hosts are verified instead of silently accepted. */
function hostVerification(): string[] {
  if (!knownHostsPath) {
    const dir = mkdtempSync(join(tmpdir(), "exe-dev-hosts-"));
    knownHostsPath = join(dir, "known_hosts");
    writeFileSync(knownHostsPath, `${PINNED_HOSTS}\n`, { mode: 0o600 });
  }
  return ["-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "StrictHostKeyChecking=yes"];
}

function ssh(args: string[]): string {
  try {
    return execFileSync("ssh", [...identity(), ...hostVerification(), ...args], { encoding: "utf8" });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const out = [err.stdout, err.stderr]
      .filter((s) => s && s.trim())
      .map((s) => s!.trim())
      .join("\n");
    throw new Error(
      `ssh failed (exit ${err.status ?? "unknown"}): ${out || String(err)}\n` +
        `command: ssh ${args.join(" ")}`,
    );
  }
}

export function vmName(issueNumber: number): string {
  const prefix = core.getInput("vm-name-prefix") || "a-factory";
  return `${prefix}-issue-${issueNumber}`;
}

export function vmUrl(name: string): string {
  return `https://${name}.exe.xyz:${HARNESS_PORT}`;
}

/** Runs a command on the VM via SSH and returns stdout. Throws if SSH or the remote
 *  command exits non-zero. */
export function sshExec(vmName: string, command: string): string {
  return ssh([`${vmName}.exe.xyz`, command]);
}

/** Creates a VM. pi-harness starts automatically via systemd — no SSH bootstrap needed.
 *  VM-level env vars come from vm-env input (e.g. OPENCODE_API_KEY).
 *  GitHub access is handled by exe.dev's GitHub integration. */
export function createVm(name: string, extraEnv: string[] = []): void {
  const image = core.getInput("vm-image");
  const cpu = core.getInput("vm-cpu");
  const disk = core.getInput("vm-disk");
  const memory = core.getInput("vm-memory");
  const tags = core
    .getInput("vm-tag")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const vmEnv = [
    ...core
      .getInput("vm-env")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    ...extraEnv,
  ];
  core.info(`exe: creating VM ${name}${image ? ` (image ${image})` : ""}`);
  ssh([
    "exe.dev",
    "new",
    "--name",
    name,
    ...(image ? ["--image", image] : []),
    ...(cpu ? ["--cpu", cpu] : []),
    ...(disk ? ["--disk", disk] : []),
    ...(memory ? ["--memory", memory] : []),
    ...tags.flatMap((t) => ["--tag", t]),
    ...vmEnv.flatMap((e) => ["--env", e]),
    "--no-email",
  ]);
}

/** Deletes a VM. Swallows "doesn't exist" failures — callers use this as a safety-net
 *  cleanup that may race with (or repeat) an earlier teardown. */
export function destroyVm(name: string): void {
  try {
    core.info(`exe: destroying VM ${name}`);
    ssh(["exe.dev", "rm", name]);
  } catch (e) {
    core.warning(`exe: destroy ${name} failed (already gone?): ${(e as Error).message}`);
  }
}
