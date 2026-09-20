import chalk from "chalk";
import type { BisectState } from "./bayes.js";
import type { Evidence } from "./es/search.js";

const isTTY = process.stdout.isTTY && !process.env.CI;

class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private text: string) {
    if (isTTY) {
      this.timer = setInterval(() => this.draw(), 80);
      this.draw();
    } else {
      process.stdout.write(chalk.dim(`… ${text}\n`));
    }
  }
  private draw() {
    process.stdout.write(`\r${chalk.magenta(this.frames[(this.i = (this.i + 1) % this.frames.length)])} ${this.text}\x1b[K`);
  }
  update(text: string) {
    this.text = text;
    if (!isTTY) process.stdout.write(chalk.dim(`… ${text}\n`));
  }
  stop(finalText?: string, ok = true) {
    if (this.timer) clearInterval(this.timer);
    const mark = ok ? chalk.green("✔") : chalk.red("✖");
    if (isTTY) process.stdout.write(`\r${mark} ${finalText ?? this.text}\x1b[K\n`);
    else process.stdout.write(`${mark} ${finalText ?? this.text}\n`);
  }
}

export const ui = {
  bold: (s: string) => chalk.bold(s),
  dim: (s: string) => chalk.dim(s),
  spinner: (text: string) => new Spinner(text),
  banner() {
    console.log(
      chalk.magenta.bold(`
 __      __.__               .___             .__  __
/  \\    /  \\  |__   ____   __| _/_ __  ____   |__|/  |_
\\   \\/\\/   /  |  \\ /  _ \\ / __ |  |  \\/    \\  |  \\   __\\
 \\        /|   Y  (  <_> ) /_/ |  |  /   |  \\ |  ||  |
  \\__/\\  / |___|  /\\____/\\____ |____/|___|  / |__||__|
       \\/       \\/            \\/          \\/`) + chalk.dim("\n  git bisect with a brain · Elasticsearch is the case file\n"),
    );
  },
  section(title: string) {
    console.log(`\n${chalk.bgMagenta.black.bold(` ${title} `)}`);
  },
  info(msg: string) {
    console.log(`${chalk.cyan("ℹ")} ${msg}`);
  },
  ok(msg: string) {
    console.log(`${chalk.green("✔")} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${chalk.yellow("▲")} ${msg}`);
  },
  fail(msg: string) {
    console.log(`${chalk.red("✖")} ${msg}`);
  },
  kv(k: string, v: string) {
    console.log(`  ${chalk.dim(k.padEnd(16))} ${v}`);
  },
  evidence(list: Evidence[], max = 8) {
    for (const e of list.slice(0, max)) {
      const tag = {
        commit: chalk.blue("commit "),
        hunk: chalk.green("hunk   "),
        "ci-log": chalk.yellow("ci-log "),
        issue: chalk.magenta("issue  "),
      }[e.kind];
      const via = chalk.dim(`[${e.via.join("+")}]`);
      console.log(`  ${tag} ${chalk.bold(e.title.slice(0, 90))} ${via}`);
      const snippet = e.snippet.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ⏎ ");
      if (snippet) console.log(`          ${chalk.dim(snippet.slice(0, 140))}`);
    }
  },
  /** Render the posterior over commits as a probability histogram. */
  posterior(
    state: BisectState,
    labels: (i: number) => string,
    opts: { highlight?: number; width?: number; maxRows?: number } = {},
  ) {
    const width = opts.width ?? 30;
    const maxRows = opts.maxRows ?? 12;
    const max = Math.max(...state.posterior, 1e-9);
    const idx = state.posterior
      .map((p, i) => [p, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, maxRows)
      .map(([, i]) => i)
      .sort((a, b) => a - b);
    const probed = new Map(state.probes.map((p) => [p.index, p.result]));
    for (const i of idx) {
      const p = state.posterior[i];
      const bar = "█".repeat(Math.max(p > 0 ? 1 : 0, Math.round((p / max) * width)));
      const color = i === opts.highlight ? chalk.red : p / max > 0.5 ? chalk.yellow : chalk.dim;
      const mark = probed.get(i) === "bad" ? chalk.red("✗") : probed.get(i) === "good" ? chalk.green("✓") : " ";
      console.log(`  ${mark} ${String(i).padStart(4)} ${color(bar.padEnd(width))} ${(p * 100).toFixed(1).padStart(5)}%  ${chalk.dim(labels(i).slice(0, 60))}`);
    }
    const shown = idx.reduce((a, i) => a + state.posterior[i], 0);
    if (shown < 0.999) console.log(chalk.dim(`  … ${state.n - idx.length} more commits share the remaining ${((1 - shown) * 100).toFixed(1)}%`));
  },
  probeLine(step: number, index: number, short: string, subject: string, result: "good" | "bad", pBad: number, ms: number) {
    const res = result === "bad" ? chalk.red.bold("BAD ") : chalk.green.bold("GOOD");
    const surprise = result === "bad" ? 1 - pBad : pBad;
    const tag = surprise < 0.25 ? chalk.yellow(" (surprise!)") : "";
    console.log(
      `  ${chalk.dim(`#${step}`)} probe ${chalk.bold(`#${index}`)} ${chalk.cyan(short)} ${chalk.dim(subject.slice(0, 48))} → ${res} ${chalk.dim(`P(bad)=${(pBad * 100).toFixed(0)}% · ${ms}ms`)}${tag}`,
    );
  },
};
