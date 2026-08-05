import { sshExec, HARNESS_PORT } from "./exe.js";

/** Resumes a pending question on the harness. Fire-and-forget: the curl is detached on the
 *  VM (nohup + background), so the SSH call returns immediately and the Action never waits
 *  for the harness to finish the resumed run. */
export function resumeSession(vm: string): void {
  const cmd = `nohup curl -s -X POST http://localhost:${HARNESS_PORT}/issue/comment >/dev/null 2>&1 &`;
  sshExec(vm, cmd);
}
