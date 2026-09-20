/* Mirrors src/events.ts on the server — the single contract shared by live and simulated cases. */

export type ProbeResult = "good" | "bad";

export interface PublicCommit {
  index: number;
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  /** heat: posterior relative to the most likely commit (0..1) */
  p?: number;
  /** absolute posterior probability */
  mass?: number;
  probed?: ProbeResult;
  ci?: "passed" | "failed";
}

export type EvidenceKind = "commit" | "hunk" | "ci-log" | "issue";

export interface Evidence {
  kind: EvidenceKind;
  id: string;
  score: number;
  sha?: string;
  order?: number;
  title: string;
  snippet: string;
  file?: string;
  date?: string;
  via: string[];
}

export interface Suspect {
  sha: string;
  score: number;
  reason: string;
  commit?: PublicCommit;
}

export interface AmendsResult {
  branch: string;
  commitSha: string;
  summary: string;
  filesChanged: string[];
  prUrl?: string;
  verifyPassed?: boolean;
  diff?: string;
  commitMessage?: string;
}

export interface OpenedPayload {
  caseId: string;
  repo: string;
  description: string;
  brain: string;
  vectors: string;
  range: string;
  commitCount: number;
  oldest: PublicCommit;
  newest: PublicCommit;
  commits: PublicCommit[];
}

export interface ProbePayload {
  step: number;
  index: number;
  commit: PublicCommit;
  result: ProbeResult;
  pBad: number;
  durationMs: number;
  by: "detective" | "player";
  flaked?: boolean;
}

export interface AwaitingPayload {
  step: number;
  autoIndex: number | null;
  autoCommit?: PublicCommit;
  board: PublicCommit[];
  message: string;
}

export interface PriorPayload {
  entropyBits: number;
  uniformBits: number;
  uniformProbes: number;
  credible90: number;
  board: PublicCommit[];
}

export interface CulpritPayload {
  commit: PublicCommit;
  confidence: number;
  probes: number;
  uniformSteps: number;
  /** simulation only: the commit classic git bisect would have blamed under the same (flaky) oracle */
  gitVerdict?: number;
  gitSteps?: number[];
}

export interface TargetingPayload {
  step: number;
  index: number;
  commit: PublicCommit;
  pBad: number;
  by: "detective" | "player";
}

export type CaseEvent =
  | { type: "opened"; payload: OpenedPayload }
  | { type: "phase"; payload: { phase: string; title: string } }
  | { type: "tool"; payload: { name: string; args: Record<string, unknown> } }
  | { type: "evidence"; payload: { items: Evidence[] } }
  | { type: "theory"; payload: { notes: string; mode: string; queries: string[] } }
  | { type: "suspects"; payload: { suspects: Suspect[] } }
  | { type: "repro"; payload: { explanation: string; command: string; headOutput: string } }
  | { type: "prior"; payload: PriorPayload }
  | { type: "awaiting_probe"; payload: AwaitingPayload }
  | { type: "targeting"; payload: TargetingPayload }
  | { type: "probe"; payload: ProbePayload }
  | { type: "posterior"; payload: { board: PublicCommit[]; highlight?: number } }
  | { type: "culprit"; payload: CulpritPayload }
  | { type: "verdict"; payload: { markdown: string } }
  | { type: "amends"; payload: AmendsResult }
  | { type: "closed"; payload: { caseId: string; caseFile: string } }
  | { type: "note"; payload: { level: "info" | "warn"; text: string } }
  | { type: "error"; payload: { message: string } };

export type EventType = CaseEvent["type"];

export const EVENT_TYPES: EventType[] = [
  "opened",
  "phase",
  "tool",
  "evidence",
  "theory",
  "suspects",
  "repro",
  "prior",
  "awaiting_probe",
  "targeting",
  "probe",
  "posterior",
  "culprit",
  "verdict",
  "amends",
  "closed",
  "note",
  "error",
];

export type Mode = "auto" | "player";

export interface ServerStatus {
  es: string | null;
  esUrl?: string;
  brain: string | null;
  vectors: string;
  repo: string;
  repoPath: string;
  commitCount: number;
  demoComplaint: string;
  canFix?: boolean;
}

export interface CaseOptions {
  description: string;
  mode: Mode;
  /** assumed flake rate of the oracle (Bayesian noise margin) */
  eps: number;
  /** demo: simulate a flaky oracle */
  flaky: boolean;
}

/** A running case, live or simulated, exposes the same handle. */
export interface CaseHandle {
  id: string;
  kind: "live" | "mock";
  submitProbe(index: number | "auto"): Promise<void>;
  requestFix(branch?: string): Promise<AmendsResult>;
  close(): void;
}
