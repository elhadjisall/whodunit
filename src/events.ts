import type { Evidence } from "./es/search.js";
import type { CommitInfo } from "./git.js";
import type { AmendsResult } from "./agent/amends.js";
import type { Suspect } from "./agent/investigate.js";

export interface PublicCommit {
  index: number;
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  /** posterior relative to the most likely commit (0..1) — the "heat" */
  p?: number;
  /** absolute posterior probability mass (0..1) */
  mass?: number;
  probed?: "good" | "bad";
  /** CI status of the run at this commit, when a log was indexed */
  ci?: "passed" | "failed";
}

export function publicCommit(
  c: CommitInfo,
  extra: { p?: number; mass?: number; probed?: "good" | "bad"; ci?: "passed" | "failed" } = {},
): PublicCommit {
  return {
    index: c.order,
    sha: c.sha,
    short: c.short,
    author: c.author,
    date: c.date,
    subject: c.subject,
    files: c.files,
    ...extra,
  };
}

export type CaseEvent =
  | { type: "opened"; payload: { caseId: string; repo: string; description: string; brain: string; vectors: string; range: string; commitCount: number; oldest: PublicCommit; newest: PublicCommit; commits: PublicCommit[] } }
  | { type: "phase"; payload: { phase: string; title: string } }
  | { type: "tool"; payload: { name: string; args: Record<string, unknown> } }
  | { type: "evidence"; payload: { items: Evidence[] } }
  | { type: "theory"; payload: { notes: string; mode: string; queries: string[] } }
  | { type: "suspects"; payload: { suspects: (Suspect & { commit?: PublicCommit })[] } }
  | { type: "repro"; payload: { explanation: string; command: string; headOutput: string } }
  | { type: "prior"; payload: { entropyBits: number; uniformBits: number; uniformProbes: number; credible90: number; board: PublicCommit[] } }
  | { type: "awaiting_probe"; payload: { step: number; autoIndex: number | null; autoCommit?: PublicCommit; board: PublicCommit[]; message: string } }
  | { type: "targeting"; payload: { step: number; index: number; commit: PublicCommit; pBad: number; by: "detective" | "player" } }
  | { type: "probe"; payload: { step: number; index: number; commit: PublicCommit; result: "good" | "bad"; pBad: number; durationMs: number; by: "detective" | "player"; flaked?: boolean } }
  | { type: "posterior"; payload: { board: PublicCommit[]; highlight?: number } }
  | { type: "culprit"; payload: { commit: PublicCommit; confidence: number; probes: number; uniformSteps: number; gitVerdict?: number; gitSteps?: number[] } }
  | { type: "verdict"; payload: { markdown: string } }
  | { type: "amends"; payload: AmendsResult }
  | { type: "closed"; payload: { caseId: string; caseFile: string } }
  /** operational chatter worth showing the player (rate-limit retries, fallbacks) */
  | { type: "note"; payload: { level: "info" | "warn"; text: string } }
  /** Timing tick so the UI can show ES kNN vs Gemini vs oracle latency live */
  | { type: "span"; payload: { name: string; op: string; durationMs: number; attrs?: Record<string, string | number | boolean | undefined> } }
  | { type: "error"; payload: { message: string } };

export type CaseEmitter = (event: CaseEvent) => void;

export interface ProbeChoice {
  caseId: string;
  step: number;
  autoIndex: number | null;
  board: PublicCommit[];
}

export type ChooseProbe = (ctx: ProbeChoice) => Promise<number | "auto">;
