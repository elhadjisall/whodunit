import type { BisectState } from "../bayes.js";
import { entropyBits, uniformProbes } from "../bayes.js";
import type { Evidence } from "../es/search.js";
import type { CommitInfo, Hunk } from "../git.js";
import { chatText, hasLLM } from "./llm.js";

export interface VerdictInput {
  repo: string;
  description: string;
  culprit: CommitInfo;
  hunks: Hunk[];
  evidence: Evidence[];
  notes: string;
  state: BisectState;
  commits: CommitInfo[];
  uniformSteps?: number;
  reproExplanation: string;
  reproOutput: string;
}

export async function writeVerdict(input: VerdictInput): Promise<string> {
  const { state, culprit } = input;
  const realProbes = state.probes.filter((p) => p.durationMs > 0);
  const probes = realProbes.length;
  const uniform = input.uniformSteps ?? uniformProbes(state.n - 1);
  const stats = `Bisection: ${probes} test run(s) vs ${uniform} for classic git bisect over ${state.n} commits; prior entropy ${entropyBits(state.prior).toFixed(2)} bits (uniform: ${Math.log2(state.n - 1).toFixed(2)}); final confidence ${(Math.max(...state.posterior) * 100).toFixed(1)}%.`;

  if (!hasLLM()) {
    return [
      `## Verdict`,
      ``,
      `**Culprit:** \`${culprit.short}\` — ${culprit.subject} (${culprit.author}, ${culprit.date.slice(0, 10)})`,
      ``,
      `Files touched: ${culprit.files.join(", ")}`,
      ``,
      stats,
      ``,
      `### Reproduction output at culprit`,
      "```",
      input.reproOutput.trim().slice(0, 1500),
      "```",
      ``,
      `_Set OPENAI_API_KEY for a narrated, cited explanation._`,
    ].join("\n");
  }

  const hunkText = input.hunks
    .map((h, i) => `[hunk ${i + 1}] ${h.file} ${h.header}\n${h.text.slice(0, 2500)}`)
    .join("\n\n");
  const evidenceText = input.evidence
    .slice(0, 12)
    .map((e, i) => `[evidence ${i + 1}] (${e.kind}) ${e.title}\n${e.snippet.slice(0, 600)}`)
    .join("\n\n");
  const probeLog = realProbes
    .map((p, i) => `${i + 1}. #${p.index} ${input.commits[p.index].short} "${input.commits[p.index].subject}" → ${p.result.toUpperCase()} (predicted P(bad)=${(p.pBadBefore * 100).toFixed(0)}%)`)
    .join("\n");

  const system = `You are whodunit, a software detective delivering a verdict to the developer who reported a regression. Write a
crisp, well-cited Markdown case report. Every factual claim about code must cite a hunk ([hunk N]) or evidence ([evidence N]) or the
probe log. Explain the mechanism of the bug precisely (what the diff changed and why that produces the observed symptom). Note any
red herrings the evidence contained and why they were innocent. Keep it under 350 words. Sections: **Verdict**, **How it broke**,
**Evidence**, **Red herrings** (if any), **Investigation stats**. Do not invent facts not in the material.`;
  const user = `Bug report: ${input.description}

Culprit commit: ${culprit.sha} (${culprit.short}) by ${culprit.author} on ${culprit.date}
Subject: ${culprit.subject}
Message: ${culprit.message}
Files: ${culprit.files.join(", ")}

Culprit diff:
${hunkText}

Reproduction test: ${input.reproExplanation}
Reproduction output at culprit:
${input.reproOutput.slice(0, 1500)}

Detective's notes: ${input.notes}

Evidence retrieved from Elasticsearch:
${evidenceText}

Probe log (Bayesian bisection):
${probeLog}

${stats}`;
  return chatText(system, user);
}
