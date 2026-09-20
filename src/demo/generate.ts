/**
 * Generates the "acme-ledger" demo repository: a small invoicing library with ~120 commits, several
 * plausible red herrings, noisy CI logs, a handful of issue threads, and ONE subtle regression that
 * the existing test-suite does not catch (credit notes with a discount lose a cent in CSV export).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/* ----------------------------- deterministic RNG ----------------------------- */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AUTHORS = [
  ["Priya Natarajan", "priya@acme.example"],
  ["Marcus Chen", "marcus@acme.example"],
  ["Sofia Alvarez", "sofia@acme.example"],
  ["Tomasz Nowak", "tomasz@acme.example"],
  ["Dev Patel", "dev@acme.example"],
] as const;

/* ----------------------------- source templates ------------------------------ */
interface Flags {
  allocate: boolean;
  allocateTrunc: boolean; // <-- the regression
  moneyDoc: boolean;
  tax: boolean;
  taxNegativeFix: boolean;
  taxManitoba: boolean;
  invoice: boolean;
  discount: boolean;
  creditNotes: boolean;
  csv: boolean;
  csvStreaming: boolean;
  csvQuoting: boolean;
  report: boolean;
  reportProvince: boolean;
  version: string;
}

const moneyJs = (f: Flags) => `// Money helpers. All amounts are integer cents to avoid floating point drift.
${f.moneyDoc ? "\n/** Convert a decimal dollar amount to integer cents. */" : ""}
export function toCents(amount) {
  return Math.round(amount * 100);
}

export function fromCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}

export function sumCents(list) {
  return list.reduce((acc, c) => acc + c, 0);
}
${
  f.allocate
    ? f.allocateTrunc
      ? `
${f.moneyDoc ? "/**\n * Split totalCents across weights proportionally; the remainder cents are handed out\n * round-robin so that the shares always sum to the total.\n */" : ""}
export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.trunc((totalCents * w) / sum));
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
    shares[i] += 1;
    remainder -= 1;
  }
  return shares;
}
`
      : `
${f.moneyDoc ? "/**\n * Split totalCents across weights proportionally; the remainder cents are handed out\n * round-robin so that the shares always sum to the total.\n */" : ""}
export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((totalCents * w) / sum));
  // floor() always rounds toward -Infinity, so the remainder is >= 0 for any sign of total
  let remainder = totalCents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length) {
    shares[i] += 1;
    remainder -= 1;
  }
  return shares;
}
`
    : ""
}`;

const taxJs = (f: Flags) => `// Canadian sales tax tables (combined GST/HST/PST), by province code.
export const RATES = {
  ON: 0.13,
  BC: 0.12,
  AB: 0.05,
  QC: 0.14975,
  NS: 0.15,${f.taxManitoba ? "\n  MB: 0.12," : ""}
};

${
  f.taxNegativeFix
    ? `function roundHalfUp(x) {
  // Symmetric rounding so credit notes (negative) mirror invoices exactly.
  return Math.sign(x) * Math.round(Math.abs(x));
}`
    : `function roundHalfUp(x) {
  return Math.round(x);
}`
}

export function taxCents(subtotalCents, province) {
  const rate = RATES[province];
  if (rate === undefined) throw new Error(\`unknown province \${province}\`);
  return roundHalfUp(subtotalCents * rate);
}
`;

const invoiceJs = (f: Flags) => `import { ${f.discount ? "allocate, " : ""}sumCents } from "./money.js";
import { taxCents } from "./tax.js";

export function createInvoice({ id, customer, province, lines, discountCents = 0 }) {
  return { id, customer, province, lines: lines.map((l) => ({ ...l })), discountCents };
}

export function lineTotalCents(line) {
  return line.qty * line.unitCents;
}

export function subtotalCents(inv) {
  return sumCents(inv.lines.map(lineTotalCents));
}
${
  f.discount
    ? `
/** Distribute the invoice-level discount across lines, proportional to line totals. */
export function netLines(inv) {
  const gross = inv.lines.map(lineTotalCents);
  const discount = allocate(inv.discountCents, gross.map((g) => Math.abs(g)));
  return inv.lines.map((l, i) => ({ ...l, grossCents: gross[i], netCents: gross[i] - discount[i] }));
}
`
    : ""
}
export function summarize(inv) {
  const subtotal = subtotalCents(inv);
  const discount = inv.discountCents ?? 0;
  const taxable = subtotal - discount;
  const tax = taxCents(taxable, inv.province);
  return { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: taxable + tax };
}
${
  f.creditNotes
    ? `
/** A credit note reverses an invoice: same lines, negated quantities, negated discount. */
export function creditNote(inv, id = \`CN-\${inv.id}\`) {
  return createInvoice({
    id,
    customer: inv.customer,
    province: inv.province,
    lines: inv.lines.map((l) => ({ ...l, qty: -l.qty })),
    discountCents: -(inv.discountCents ?? 0),
  });
}
`
    : ""
}`;

const csvJs = (f: Flags) => `import { fromCents } from "./money.js";
import { ${f.discount ? "netLines, " : ""}summarize, lineTotalCents } from "./invoice.js";
import { taxCents } from "./tax.js";

${
  f.csvQuoting
    ? `function cell(v) {
  const s = String(v);
  return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;
}`
    : `function cell(v) {
  return String(v);
}`
}

const HEADER = ["invoice_id", "line", "description", "qty", "unit", "net"];

/** Export invoices as CSV. Each invoice ends with a TOTAL row computed from its exported lines. */
export function exportInvoices(invoices) {
  ${f.csvStreaming ? "const out = [HEADER.join(\",\")];" : "let out = HEADER.join(\",\") + \"\\n\";"}
  for (const inv of invoices) {
    const lines = ${f.discount ? "netLines(inv)" : "inv.lines.map((l) => ({ ...l, netCents: lineTotalCents(l) }))"};
    let running = 0;
    lines.forEach((l, i) => {
      running += l.netCents;
      ${f.csvStreaming ? "out.push(" : "out += "}[inv.id, i + 1, l.description, l.qty, fromCents(l.unitCents), fromCents(l.netCents)].map(cell).join(",")${f.csvStreaming ? ");" : ' + "\\n";'}
    });
    const tax = taxCents(running, inv.province);
    ${f.csvStreaming ? "out.push(" : "out += "}[inv.id, "TOTAL", "", "", fromCents(tax), fromCents(running + tax)].map(cell).join(",")${f.csvStreaming ? ");" : ' + "\\n";'}
  }
  ${f.csvStreaming ? 'return out.join("\\n") + "\\n";' : "return out;"}
}

export function headerTotal(inv) {
  return fromCents(summarize(inv).totalCents);
}
`;

const reportJs = (f: Flags) => `import { summarize } from "./invoice.js";
import { fromCents } from "./money.js";

/** Monthly totals${f.reportProvince ? " grouped by province" : ""}. */
export function monthlySummary(invoices, month) {
  const rows = invoices.filter((i) => (i.issuedAt ?? "").startsWith(month));
  ${
    f.reportProvince
      ? `const byProvince = new Map();
  for (const inv of rows) {
    const s = summarize(inv);
    byProvince.set(inv.province, (byProvince.get(inv.province) ?? 0) + s.totalCents);
  }
  return Object.fromEntries([...byProvince].map(([p, c]) => [p, fromCents(c)]));`
      : `const total = rows.reduce((acc, inv) => acc + summarize(inv).totalCents, 0);
  return { month, invoices: rows.length, total: fromCents(total) };`
  }
}
`;

const invoiceTest = (f: Flags) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { createInvoice, summarize${f.discount ? ", netLines" : ""} } from "../src/invoice.js";

const inv = createInvoice({
  id: "INV-1001",
  customer: "Northwind",
  province: "ON",
  lines: [
    { description: "Widget", qty: 3, unitCents: 1999 },
    { description: "Gadget", qty: 1, unitCents: 4500 },
  ],
  discountCents: ${f.discount ? "1000" : "0"},
});

test("subtotal and tax", () => {
  const s = summarize(inv);
  assert.equal(s.subtotalCents, 10497);
  assert.equal(s.totalCents, ${f.discount ? "10732" : "11862"});
});
${
  f.discount
    ? `
test("discount is fully allocated across lines", () => {
  const lines = netLines(inv);
  const net = lines.reduce((a, l) => a + l.netCents, 0);
  assert.equal(net, 9497);
});
`
    : ""
}`;

const moneyTest = (f: Flags) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, fromCents${f.allocate ? ", allocate" : ""} } from "../src/money.js";

test("cents round trip", () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(fromCents(1999), "19.99");
  assert.equal(fromCents(-5), "-0.05");
});
${
  f.allocate
    ? `
test("allocate sums to total", () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.equal(allocate(999, [3, 2, 1]).reduce((a, b) => a + b, 0), 999);
});
`
    : ""
}`;

const csvTest = (f: Flags) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { createInvoice } from "../src/invoice.js";
import { exportInvoices } from "../src/csv.js";

test("csv has header and total row", () => {
  const inv = createInvoice({ id: "INV-7", customer: "Acme", province: "BC", lines: [{ description: "Thing", qty: 2, unitCents: 500 }] });
  const csv = exportInvoices([inv]);
  assert.match(csv, /^invoice_id,line,description,qty,unit,net/);
  assert.match(csv, /INV-7,TOTAL,,,1.20,11.20/);
});
`;

const packageJson = (f: Flags) => `{
  "name": "@acme/ledger",
  "version": "${f.version}",
  "type": "module",
  "description": "Invoicing primitives: money, tax, invoices, CSV export",
  "scripts": {
    "test": "node --test test/"
  },
  "license": "MIT"
}
`;

/* ----------------------------- commit script --------------------------------- */
interface Step {
  msg: string;
  author?: number;
  apply: (f: Flags, files: Map<string, string>, rng: () => number) => void;
  culprit?: boolean;
  tag?: string;
}

const NOISE_FILES = ["docs/architecture.md", "CHANGELOG.md", "README.md", ".github/workflows/ci.yml", "docs/tax-notes.md", "fixtures/customers.json"];

function renderSources(f: Flags, files: Map<string, string>) {
  files.set("package.json", packageJson(f));
  files.set("src/money.js", moneyJs(f));
  files.set("test/money.test.js", moneyTest(f));
  if (f.tax) files.set("src/tax.js", taxJs(f));
  if (f.invoice) {
    files.set("src/invoice.js", invoiceJs(f));
    files.set("test/invoice.test.js", invoiceTest(f));
  }
  if (f.csv) {
    files.set("src/csv.js", csvJs(f));
    files.set("test/csv.test.js", csvTest(f));
  }
  if (f.report) files.set("src/report.js", reportJs(f));
}

const MEANINGFUL: Step[] = [
  {
    msg: "chore: scaffold @acme/ledger with money helpers\n\nInteger cents everywhere. No deps.",
    author: 0,
    apply: (f, files) => {
      files.set(".gitignore", "node_modules/\n.whodunit/\n*.log\n");
      files.set("README.md", "# @acme/ledger\n\nInvoicing primitives for Acme's billing service.\n");
      files.set("CHANGELOG.md", "# Changelog\n\n## Unreleased\n");
      files.set(".github/workflows/ci.yml", "name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 20 }\n      - run: npm test\n");
      renderSources(f, files);
    },
  },
  { msg: "feat(tax): add combined GST/HST/PST rate table by province", author: 1, apply: (f, files) => ((f.tax = true), renderSources(f, files)) },
  { msg: "feat(invoice): createInvoice, subtotal and summarize()", author: 0, apply: (f, files) => ((f.invoice = true), renderSources(f, files)) },
  { msg: "feat(csv): export invoices to CSV with a TOTAL row per invoice\n\nFinance imports this into their reconciliation sheet.", author: 2, apply: (f, files) => ((f.csv = true), renderSources(f, files)) },
  { msg: "feat(money): add allocate() to split cents proportionally without losing pennies", author: 1, apply: (f, files) => ((f.allocate = true), renderSources(f, files)) },
  { msg: "feat(invoice): invoice-level discounts allocated across lines\n\nUses money.allocate so line nets always sum to subtotal - discount.", author: 1, apply: (f, files) => ((f.discount = true), renderSources(f, files)) },
  { msg: "chore: release 1.1.0", author: 0, tag: "v1.1.0", apply: (f, files) => ((f.version = "1.1.0"), renderSources(f, files)) },
  { msg: "feat(tax): add Manitoba (MB) to rate table\n\nCloses #7", author: 3, apply: (f, files) => ((f.taxManitoba = true), renderSources(f, files)) },
  {
    msg: "feat(invoice): support credit notes\n\ncreditNote(inv) mirrors an invoice with negated quantities and discount so refunds flow through the same CSV export and reports.",
    author: 2,
    apply: (f, files) => ((f.creditNotes = true), renderSources(f, files)),
  },
  { msg: "fix(tax): symmetric rounding for negative (credit note) amounts\n\nMath.round(-0.5) is -0, not -1; use sign * round(abs) so credit notes mirror invoices.", author: 3, apply: (f, files) => ((f.taxNegativeFix = true), renderSources(f, files)) },
  { msg: "docs(money): document allocate() and toCents()", author: 4, apply: (f, files) => ((f.moneyDoc = true), renderSources(f, files)) },
  { msg: "perf(csv): build rows in an array and join once\n\n~4x faster on the 50k-invoice export.", author: 2, apply: (f, files) => ((f.csvStreaming = true), renderSources(f, files)) },
  { msg: "chore: release 1.2.0", author: 0, tag: "v1.2.0", apply: (f, files) => ((f.version = "1.2.0"), renderSources(f, files)) },
  {
    msg: "refactor(money): simplify allocate() remainder distribution\n\nUse Math.trunc for the initial shares (reads clearer than floor for our positive-cents use case) and drop the sign comment. No behaviour change intended; tests green.",
    author: 4,
    culprit: true,
    apply: (f, files) => ((f.allocateTrunc = true), renderSources(f, files)),
  },
  { msg: "feat(report): monthly summary of issued invoices", author: 3, apply: (f, files) => ((f.report = true), renderSources(f, files)) },
  { msg: "fix(csv): quote fields containing commas, quotes or newlines\n\nCloses #9 — Excel import broke on descriptions like \"Widget, blue\".", author: 2, apply: (f, files) => ((f.csvQuoting = true), renderSources(f, files)) },
  { msg: "feat(report): group monthly summary by province\n\nCloses #5", author: 3, apply: (f, files) => ((f.reportProvince = true), renderSources(f, files)) },
  { msg: "chore: release 1.3.0", author: 0, tag: "v1.3.0", apply: (f, files) => ((f.version = "1.3.0"), renderSources(f, files)) },
];

const NOISE_TEMPLATES: ((rng: () => number, files: Map<string, string>, i: number) => string)[] = [
  (rng, files, i) => {
    files.set("CHANGELOG.md", (files.get("CHANGELOG.md") ?? "# Changelog\n") + `- ${["Improve", "Clarify", "Document", "Tidy"][Math.floor(rng() * 4)]} ${["CSV export", "tax rounding", "discount allocation", "report output", "README"][Math.floor(rng() * 5)]} (#${20 + i})\n`);
    return "docs: update changelog";
  },
  (rng, files) => {
    files.set("README.md", (files.get("README.md") ?? "") + `\n${["## Usage", "## Notes", "## FAQ", "## Provinces"][Math.floor(rng() * 4)]}\n\n${["All amounts are integer cents.", "Tax rates are combined GST/HST/PST.", "Discounts are allocated per line.", "Credit notes negate quantities."][Math.floor(rng() * 4)]}\n`);
    return ["docs(readme): expand usage notes", "docs: fix typo in README", "docs: clarify cents convention"][Math.floor(rng() * 3)];
  },
  (rng, files) => {
    files.set(".github/workflows/ci.yml", (files.get(".github/workflows/ci.yml") ?? "") + `      # tweak ${Math.floor(rng() * 1000)}\n`);
    return ["ci: cache npm", "ci: run on node 22 too", "ci: bump actions/checkout", "ci: retry flaky registry fetches"][Math.floor(rng() * 4)];
  },
  (rng, files, i) => {
    const customers = JSON.parse(files.get("fixtures/customers.json") ?? "[]") as unknown[];
    customers.push({ id: `C-${100 + i}`, name: ["Northwind", "Globex", "Initech", "Umbrella", "Hooli"][Math.floor(rng() * 5)] + ` ${i}`, province: ["ON", "BC", "AB", "QC"][Math.floor(rng() * 4)] });
    files.set("fixtures/customers.json", JSON.stringify(customers, null, 2) + "\n");
    return "test: add customer fixture";
  },
  (rng, files) => {
    files.set("docs/tax-notes.md", (files.get("docs/tax-notes.md") ?? "# Tax notes\n") + `- ${["QC applies QST on top of GST", "AB has no PST", "HST provinces: ON, NS, NB, NL, PE", "Rates verified against CRA tables"][Math.floor(rng() * 4)]}\n`);
    return ["docs(tax): note provincial quirks", "docs(tax): verify against CRA"][Math.floor(rng() * 2)];
  },
  (rng, files) => {
    files.set("docs/architecture.md", (files.get("docs/architecture.md") ?? "# Architecture\n") + `\n${["money → invoice → csv", "report reads summarize()", "no floating point in totals", "csv TOTAL row is derived from exported lines"][Math.floor(rng() * 4)]}\n`);
    return "docs(architecture): add notes";
  },
  (rng, files, i) => {
    files.set(`src/util/${["format", "dates", "ids", "assert"][i % 4]}.js`, `// helper added in sprint ${Math.floor(i / 10)}\nexport function ${["pad", "isoMonth", "nextId", "invariant"][i % 4]}(x) {\n  return x; // TODO ${Math.floor(rng() * 90) + 10}\n}\n`);
    return ["chore(util): add helper", "refactor(util): extract helper", "chore: add util stub"][Math.floor(rng() * 3)];
  },
];

/* ------------------------------ CI log synthesis ----------------------------- */
function ciLog(rng: () => number, sha: string, order: number, f: Flags, opts: { flaky: boolean; drift: boolean }) {
  const tests = ["money > cents round trip", f.allocate ? "money > allocate sums to total" : null, f.invoice ? "invoice > subtotal and tax" : null, f.discount ? "invoice > discount is fully allocated across lines" : null, f.csv ? "csv > csv has header and total row" : null].filter(Boolean) as string[];
  const lines: string[] = [];
  lines.push(`\u001b[36m##[group]\u001b[0mRun actions/checkout@v4`);
  lines.push(`Syncing repository: acme/ledger  HEAD is now at ${sha.slice(0, 7)}`);
  lines.push(`\u001b[36m##[endgroup]\u001b[0m`);
  lines.push(`Run actions/setup-node@v4  node-version: 20  ✔ Found in cache @ /opt/hostedtoolcache/node/20.${10 + (order % 7)}.0/x64`);
  lines.push(`Run npm test`);
  if (opts.flaky) {
    lines.push(`npm WARN registry Unexpected warning for https://registry.npmjs.org/: Miscellaneous Warning ETIMEDOUT: request to https://registry.npmjs.org/ failed, reason: connect ETIMEDOUT 104.16.27.34:443`);
    lines.push(`npm WARN registry Using stale data from https://registry.npmjs.org/ due to a request error during revalidation.`);
    lines.push(`\u001b[31m##[error]\u001b[0mProcess completed with exit code 1.`);
    lines.push(`(re-run #2 by @${AUTHORS[Math.floor(rng() * AUTHORS.length)][0].split(" ")[0].toLowerCase()}: passed)`);
  }
  lines.push(`> @acme/ledger@${f.version} test`);
  lines.push(`> node --test test/`);
  for (const t of tests) lines.push(`✔ ${t} (${(rng() * 3 + 0.4).toFixed(3)}ms)`);
  if (opts.drift) {
    lines.push(`(node:${1000 + Math.floor(rng() * 9000)}) Warning: report reconcile: CSV TOTAL differs from summarize() by 0.01 for CN-INV-10${Math.floor(rng() * 90) + 10} (ignored, see #12)`);
  }
  lines.push(`ℹ tests ${tests.length}`);
  lines.push(`ℹ pass ${tests.length}`);
  lines.push(`ℹ fail 0`);
  lines.push(`ℹ duration_ms ${(80 + rng() * 60).toFixed(3)}`);
  lines.push(`\u001b[32m✓\u001b[0m Post job cleanup. Cache saved with key node-cache-Linux-npm-${sha.slice(0, 12)}`);
  return lines.join("\n");
}

/* --------------------------------- issues ----------------------------------- */
function issues(dates: string[]) {
  const d = (i: number) => dates[Math.min(i, dates.length - 1)];
  return [
    { number: 3, title: "Support QC compound tax properly", author: "tomasz", labels: ["tax"], created: d(6), body: "QST is 9.975% on top of GST 5%. Our combined 14.975 is fine for now but we should model it explicitly.", comments: ["Fine as a flat rate until we do per-line tax.", "Parking."] },
    { number: 5, title: "Monthly report should group by province", author: "finance-bot", labels: ["report"], created: d(40), body: "Finance wants the monthly summary split by province for remittance.", comments: ["On it.", "Shipped in feat(report): group by province."] },
    { number: 7, title: "Add PST for Manitoba", author: "sofia", labels: ["tax"], created: d(12), body: "We have our first MB customer. Rate is 7% PST + 5% GST = 12%.", comments: ["Added."] },
    { number: 9, title: "CSV export: fields with commas break Excel import", author: "finance-bot", labels: ["csv", "bug"], created: d(70), body: "Description \"Widget, blue\" shifts every column to the right in Excel. Please quote fields.", comments: ["Classic. Will quote commas/quotes/newlines."] },
    {
      number: 12,
      title: "Credit note CSV total is off by $0.01 vs the invoice total",
      author: "support-jamie",
      labels: ["csv", "bug", "finance"],
      created: d(88),
      body: "Customer Globex got credit note CN-INV-1042. The invoice PDF (from summarize) says -1,249.99 but the accounting CSV export TOTAL row says -1,249.98. Finance can't reconcile.\n\nIt only seems to happen on credit notes that had a discount. Regular invoices with discounts are fine. Started roughly three weeks ago — the same export was correct in the month-end run before that.",
      comments: [
        "Can't reproduce on my branch from mid-month, so it's something recent.",
        "We did change tax rounding for negatives a while back — maybe that? Although that landed before month-end and month-end was fine…",
        "The report job started logging a 'reconcile differs by 0.01' warning around the same time, might be related.",
      ],
    },
    { number: 15, title: "Flaky CI: ETIMEDOUT fetching registry", author: "marcus", labels: ["ci"], created: d(50), body: "About one in fifteen runs dies on npm registry timeouts. Retry step or cache.", comments: ["Added retries in ci.yml.", "Still happens occasionally."] },
  ];
}

/* --------------------------------- main -------------------------------------- */
export async function generateDemo(target: string, opts: { seed?: number; noise?: number } = {}): Promise<{ path: string; commits: number; culpritSha: string; culpritIndex: number }> {
  const rng = mulberry32(opts.seed ?? 42);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  const g = (args: string[], env: Record<string, string> = {}) => execFileP("git", args, { cwd: target, env: { ...process.env, ...env } });
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.name", "acme-bot"]);
  await g(["config", "user.email", "bot@acme.example"]);

  const flags: Flags = {
    allocate: false, allocateTrunc: false, moneyDoc: false, tax: false, taxNegativeFix: false, taxManitoba: false,
    invoice: false, discount: false, creditNotes: false, csv: false, csvStreaming: false, csvQuoting: false,
    report: false, reportProvince: false, version: "1.0.0",
  };
  const files = new Map<string, string>();

  // Interleave meaningful steps with noise: ~5 noise commits between each meaningful step.
  const noisePer = opts.noise ?? 5;
  const plan: (Step | "noise")[] = [];
  MEANINGFUL.forEach((s, i) => {
    plan.push(s);
    const k = i === MEANINGFUL.length - 1 ? 3 : Math.max(1, Math.round(noisePer * (0.6 + rng() * 0.8)));
    for (let j = 0; j < k; j++) plan.push("noise");
  });

  let t = Date.now() - 100 * 86400_000;
  const dates: string[] = [];
  const shas: string[] = [];
  const flagsAt: Flags[] = [];
  let culpritSha = "";
  let culpritIndex = -1;

  const commitAll = async (msg: string, authorIdx: number, when: number) => {
    for (const [p, content] of files) {
      const abs = path.join(target, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    await g(["add", "-A"]);
    const [name, email] = AUTHORS[authorIdx];
    const iso = new Date(when).toISOString();
    await g(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--allow-empty", "-m", msg], {
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    });
    const { stdout } = await g(["rev-parse", "HEAD"]);
    return { sha: stdout.trim(), iso };
  };

  let i = 0;
  for (const step of plan) {
    // advance time: 4h–30h, skew into working hours
    t += (4 + rng() * 26) * 3600_000;
    let msg: string;
    let author: number;
    if (step === "noise") {
      const tpl = NOISE_TEMPLATES[Math.floor(rng() * NOISE_TEMPLATES.length)];
      msg = tpl(rng, files, i);
      author = Math.floor(rng() * AUTHORS.length);
    } else {
      step.apply(flags, files, rng);
      msg = step.msg;
      author = step.author ?? Math.floor(rng() * AUTHORS.length);
    }
    const { sha, iso } = await commitAll(msg, author, t);
    if (step !== "noise" && step.tag) await g(["tag", step.tag]);
    if (step !== "noise" && step.culprit) {
      culpritSha = sha;
      culpritIndex = i;
    }
    shas.push(sha);
    dates.push(iso);
    flagsAt.push({ ...flags });
    i++;
  }

  // Side channels: noisy CI logs and issue threads (untracked; whodunit index picks them up)
  const ciDir = path.join(target, ".whodunit", "ci");
  const issuesDir = path.join(target, ".whodunit", "issues");
  await fs.mkdir(ciDir, { recursive: true });
  await fs.mkdir(issuesDir, { recursive: true });
  const reportIdx = plan.findIndex((s) => s !== "noise" && s.msg.startsWith("feat(report): monthly"));
  for (let k = 0; k < shas.length; k++) {
    const flaky = rng() < 0.07;
    const drift = culpritIndex >= 0 && k > Math.max(culpritIndex, reportIdx) && rng() < 0.5;
    const text = ciLog(rng, shas[k], k, flagsAt[k], { flaky, drift });
    await fs.writeFile(
      path.join(ciDir, `${shas[k]}.json`),
      JSON.stringify({ sha: shas[k], run_id: String(4100 + k), status: flaky ? "failed" : "passed", duration_ms: Math.round(38_000 + rng() * 25_000 + (flagsAt[k].csvStreaming ? -6000 : 0)), date: dates[k], text }, null, 2),
    );
  }
  for (const is of issues(dates)) await fs.writeFile(path.join(issuesDir, `${is.number}.json`), JSON.stringify(is, null, 2));

  // A hand-written oracle for keyless demos (lives outside the repo so it works at every commit).
  const oracle = `#!/usr/bin/env bash
# whodunit oracle: exit 0 if credit-note CSV TOTAL matches the invoice header total, 1 otherwise.
node --input-type=module -e '
let inv, csv, money;
try {
  inv = await import("./src/invoice.js"); csv = await import("./src/csv.js"); money = await import("./src/money.js");
} catch (e) { console.log("CSV export not present at this commit; bug cannot exist here"); process.exit(0); }
if (!csv.exportInvoices || !inv.summarize) { console.log("API not present at this commit"); process.exit(0); }
const base = { id: "INV-1042", customer: "Globex", province: "ON", lines: [
  { description: "Consulting", qty: 1, unitCents: 40000 },
  { description: "Support",    qty: 2, unitCents: 40000 } ], discountCents: 1000 };
// negate manually so this works before creditNote() existed
const cn = inv.createInvoice({ ...base, id: "CN-INV-1042", lines: base.lines.map(l => ({ ...l, qty: -l.qty })), discountCents: -base.discountCents });
const expected = money.fromCents(inv.summarize(cn).totalCents);
const out = csv.exportInvoices([cn]);
const totalRow = out.split("\\n").find(l => l.includes("TOTAL"));
const got = totalRow.split(",").pop();
console.log("header total:", expected, " csv TOTAL:", got);
process.exit(got === expected ? 0 : 1);
'
`;
  await fs.writeFile(path.join(path.dirname(target), "repro-credit-note.sh"), oracle);

  return { path: target, commits: shas.length, culpritSha, culpritIndex };
}
