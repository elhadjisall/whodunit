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
  p?: number;
  probed?: "good" | "bad";
}

export function publicCommit(c: CommitInfo, extra: { p?: number; probed?: "good" | "bad" } = {}): PublicCommit {
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
  | { type: "probe"; payload: { step: number; index: number; commit: PublicCommit; result: "good" | "bad"; pBad: number; durationMs: number; by: "detective" | "player" } }
  | { type: "posterior"; payload: { board: PublicCommit[]; highlight?: number } }
  | { type: "culprit"; payload: { commit: PublicCommit; confidence: number; probes: number; uniformSteps: number } }
  | { type: "verdict"; payload: { markdown: string } }
  | { type: "amends"; payload: AmendsResult }
  | { type: "closed"; payload: { caseId: string; caseFile: string } }
  | { type: "error"; payload: { message: string } };

export type CaseEmitter = (event: CaseEvent) => void;

export interface ProbeChoice {
  caseId: string;
  step: number;
  autoIndex: number | null;
  board: PublicCommit[];
}

export type ChooseProbe = (ctx: ProbeChoice) => Promise<number | "auto">;
