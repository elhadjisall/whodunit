/* Client-side port of src/bayes.ts — powers the offline simulation and the barometer. */
import type { ProbeResult } from "../types";

export interface Probe {
  index: number;
  result: ProbeResult;
  pBadBefore: number;
}

export interface BisectState {
  n: number;
  prior: number[];
  posterior: number[];
  eps: number;
  probes: Probe[];
}

export function entropyBits(p: number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log2(x);
  return h;
}

export function uniformProbes(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));
}

export function normalize(p: number[]): number[] {
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.map((x) => x / s) : p.map(() => 1 / p.length);
}

export function makePrior(n: number, suspicion: Map<number, number>, opts: { floor?: number; temperature?: number } = {}): number[] {
  const floor = opts.floor ?? 0.25;
  const temperature = opts.temperature ?? 1;
  const scores = Array.from({ length: n }, (_, i) => suspicion.get(i) ?? 0);
  const max = Math.max(...scores, 0);
  const exps = scores.map((s) => (s > 0 ? Math.exp((s - max) / temperature) : 0));
  const sum = exps.reduce((a, b) => a + b, 0);
  const evidencePart = sum > 0 ? exps.map((e) => e / sum) : Array(n).fill(1 / n);
  return normalize(evidencePart.map((e) => (1 - floor) * e + floor / n));
}

export function initState(prior: number[], eps = 0.05): BisectState {
  return { n: prior.length, prior: [...prior], posterior: [...prior], eps, probes: [] };
}

export function pBad(state: BisectState, k: number): number {
  let massLeq = 0;
  for (let i = 0; i <= k; i++) massLeq += state.posterior[i];
  return massLeq * (1 - state.eps) + (1 - massLeq) * state.eps;
}

/** Weighted median: the commit whose predicted outcome is closest to a coin flip. */
export function nextProbe(state: BisectState): number | null {
  const probed = new Set(state.probes.map((p) => p.index));
  let best: number | null = null;
  let bestGap = Infinity;
  let cum = 0;
  for (let k = 0; k < state.n; k++) {
    cum += state.posterior[k];
    const pb = cum * (1 - state.eps) + (1 - cum) * state.eps;
    const gap = Math.abs(pb - 0.5) + (probed.has(k) ? 1e-6 : 0);
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}

export function update(state: BisectState, k: number, result: ProbeResult): void {
  const pb = pBad(state, k);
  const post = state.posterior.map((p, i) => {
    const bad = i <= k;
    const like = result === "bad" ? (bad ? 1 - state.eps : state.eps) : bad ? state.eps : 1 - state.eps;
    return p * like;
  });
  state.posterior = normalize(post);
  state.probes.push({ index: k, result, pBadBefore: pb });
}

export function mostLikely(state: BisectState): { index: number; p: number } {
  let idx = 0;
  for (let i = 1; i < state.n; i++) if (state.posterior[i] > state.posterior[idx]) idx = i;
  return { index: idx, p: state.posterior[idx] };
}

export function credibleSet(state: BisectState, mass = 0.9): number[] {
  const order = state.posterior.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
  const out: number[] = [];
  let acc = 0;
  for (const [p, i] of order) {
    out.push(i);
    acc += p;
    if (acc >= mass) break;
  }
  return out.sort((a, b) => a - b);
}

/** Classic git bisect (midpoint on [1, n-1]) against an oracle; returns its verdict and every step. */
export function simulateGitBisect(n: number, oracle: (k: number) => ProbeResult): { steps: number[]; verdict: number } {
  let lo = 1;
  let hi = n - 1;
  const steps: number[] = [];
  while (hi > lo) {
    const mid = Math.floor((lo + hi) / 2);
    steps.push(mid);
    if (oracle(mid) === "bad") hi = mid;
    else lo = mid + 1;
  }
  return { steps, verdict: hi };
}

/** How many midpoint probes git bisect needs to land on `culprit` with a truthful oracle. */
export function uniformStepsFor(n: number, culprit: number): number {
  return simulateGitBisect(n, (k) => (k >= culprit ? "bad" : "good")).steps.length;
}
