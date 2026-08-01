import { minimatch } from "minimatch";
import { GATE } from "./config.js";

export interface Risk {
  risk: "low" | "medium" | "high";
  autoMerge: boolean;
  touchesAuth: boolean;
  touchesMigrations: boolean;
  touchesInfra: boolean;
  summary: string;
  concerns?: string[];
}

export interface GateConfig {
  maxFilesChanged: number;
  protectedPaths: readonly string[];
}

export interface GateDecision {
  autoMerge: boolean;
  reasons: string[];
}

/**
 * Deterministic auto-merge gate. The agent proposes a risk verdict; THIS disposes.
 * Pure function — no I/O — so it can be table-tested exhaustively. Config is injected
 * (defaults to the real GATE) so tests can exercise thresholds without touching env.
 */
export function gate(
  v: Risk,
  files: string[],
  validationPassed: boolean,
  config: GateConfig = GATE,
): GateDecision {
  const reasons: string[] = [];
  if (!validationPassed) reasons.push("validation did not pass");
  if (v.risk !== "low") reasons.push(`risk assessed as ${v.risk}`);
  if (v.touchesAuth) reasons.push("touches auth");
  if (v.touchesMigrations) reasons.push("touches migrations");
  if (v.touchesInfra) reasons.push("touches infra");
  if (files.length > config.maxFilesChanged)
    reasons.push(`${files.length} files changed (limit ${config.maxFilesChanged})`);

  const hitProtected = files.filter((f) =>
    config.protectedPaths.some((p) => minimatch(f, p, { dot: true })),
  );
  if (hitProtected.length) reasons.push(`protected paths: ${hitProtected.join(", ")}`);

  return { autoMerge: reasons.length === 0, reasons };
}
