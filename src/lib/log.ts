/**
 * Progress logging for the Actions run output. One consistent prefix so factory
 * progress is greppable among the rest of the job log; elapsed seconds since
 * process start so slow stages stand out without diffing timestamps.
 */
const t0 = Date.now();

export function log(message: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[factory +${elapsed}s] ${message}`);
}
