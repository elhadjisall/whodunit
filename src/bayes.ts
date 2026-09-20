/**
 * Bayesian bisection.
 *
 * Classic `git bisect` assumes every commit is equally likely to be the culprit and probes the
 * midpoint, needing ~log2(n) test runs. whodunit builds a *prior* from evidence (hybrid search over
 * diffs, commit messages, CI logs and issues) and probes the commit that splits the posterior
 * probability mass in half — the weighted median — which is the information-optimal probe under
 * symmetric noise. Each test result is treated as a noisy observation with flake rate `eps`, so a
 * single flaky run cannot send the search down the wrong branch for good.
 *
 * Convention: commits are ordered oldest (index 0) → newest (index n-1). The culprit is the first
 * bad commit. Probing commit k yields "bad" iff culprit <= k (up to noise).
 */

export type ProbeResult = "good" | "bad";

export interface Probe {
  index: number;
  result: ProbeResult;
  durationMs: number;
  pBadBefore: number; // predicted P(bad) before the probe
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

/**
 * Build a prior from suspicion scores. Scores are arbitrary non-negative "how suspicious" values
 * per commit index; they are softmax-ed with temperature and mixed with a uniform floor so that
 * no commit has zero mass (the evidence can be wrong).
 */
export function makePrior(
  n: number,
  suspicion: Map<number, number>,
  opts: { floor?: number; temperature?: number; excluded?: Set<number> } = {},
): number[] {
  const floor = opts.floor ?? 0.25;
  const temperature = opts.temperature ?? 1;
  const excluded = opts.excluded ?? new Set<number>();
  const scores = Array.from({ length: n }, (_, i) => suspicion.get(i) ?? 0);
  const max = Math.max(...scores, 0);
  const exps = scores.map((s) => (s > 0 ? Math.exp((s - max) / temperature) : 0));
  const sum = exps.reduce((a, b) => a + b, 0);
  const evidencePart = sum > 0 ? exps.map((e) => e / sum) : Array(n).fill(1 / n);
  const live = n - excluded.size;
  const p = evidencePart.map((e, i) => (excluded.has(i) ? 0 : (1 - floor) * e + floor / live));
  return normalize(p);
}

export function normalize(p: number[]): number[] {
  const s = p.reduce((a, b) => a + b, 0);
  return s > 0 ? p.map((x) => x / s) : p.map(() => 1 / p.length);
}

export function initState(prior: number[], eps = 0.05): BisectState {
  return { n: prior.length, prior: [...prior], posterior: [...prior], eps, probes: [] };
}

/** P(probe at k is bad) under the current posterior. */
export function pBad(state: BisectState, k: number): number {
  let massLeq = 0;
  for (let i = 0; i <= k; i++) massLeq += state.posterior[i];
  return massLeq * (1 - state.eps) + (1 - massLeq) * state.eps;
}

/**
 * Next probe = the commit whose predicted outcome is closest to a coin flip (weighted median).
 * Already-probed commits are eligible: when the posterior is pinned on a boundary that was tested
 * once, the most informative action is to re-run that test (a flake check). Unprobed commits win ties.
 */
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

export function update(state: BisectState, k: number, result: ProbeResult, durationMs: number): void {
  const pb = pBad(state, k);
  const post = state.posterior.map((p, i) => {
    const bad = i <= k; // if culprit is i, commit k is "truly" bad iff i <= k
    const like = result === "bad" ? (bad ? 1 - state.eps : state.eps) : bad ? state.eps : 1 - state.eps;
    return p * like;
  });
  state.posterior = normalize(post);
  state.probes.push({ index: k, result, durationMs, pBadBefore: pb });
}

export function mostLikely(state: BisectState): { index: number; p: number } {
  let idx = 0;
  for (let i = 1; i < state.n; i++) if (state.posterior[i] > state.posterior[idx]) idx = i;
  return { index: idx, p: state.posterior[idx] };
}

/** Smallest set of commits covering `mass` of the posterior (for reporting "the suspects"). */
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
