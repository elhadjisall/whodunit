import { Client } from "@elastic/elasticsearch";
import { config } from "../config.js";

let _client: Client | null = null;

export function es(): Client {
  if (_client) return _client;
  _client = new Client({
    node: config.esUrl,
    ...(config.esApiKey ? { auth: { apiKey: config.esApiKey } } : {}),
  });
  return _client;
}

export const INDEX = {
  commits: `${config.indexPrefix}-commits`,
  hunks: `${config.indexPrefix}-hunks`,
  logs: `${config.indexPrefix}-ci-logs`,
  issues: `${config.indexPrefix}-issues`,
  cases: `${config.indexPrefix}-cases`,
} as const;

export async function pingEs(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const info = await es().info();
    return { ok: true, version: info.version.number };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const textWithKeyword = { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } } as const;

function denseVector(dims: number) {
  return { type: "dense_vector", dims, index: true, similarity: "cosine" } as const;
}

/** Code-aware analyzer: splits camelCase / snake_case and keeps the original token. */
const codeSettings: import("@elastic/elasticsearch/lib/api/types").IndicesIndexSettings = {
  analysis: {
    filter: {
      code_delimiter: {
        type: "word_delimiter_graph",
        split_on_case_change: true,
        split_on_numerics: true,
        preserve_original: true,
        stem_english_possessive: false,
      },
    },
    analyzer: {
      code: {
        type: "custom",
        tokenizer: "standard",
        filter: ["code_delimiter", "flatten_graph", "lowercase", "asciifolding", "stop"],
      },
    },
  },
};

export async function ensureIndices(dims: number | null, reset = false): Promise<void> {
  const client = es();
  const vec = dims ? { embedding: denseVector(dims) } : {};

  const defs: Record<string, Record<string, unknown>> = {
    [INDEX.commits]: {
      repo: { type: "keyword" },
      sha: { type: "keyword" },
      short: { type: "keyword" },
      order: { type: "integer" },
      subject: { type: "text", analyzer: "code" },
      message: { type: "text", analyzer: "code" },
      author: textWithKeyword,
      date: { type: "date" },
      files: { type: "keyword" },
      files_text: { type: "text", analyzer: "code" },
      insertions: { type: "integer" },
      deletions: { type: "integer" },
      ...vec,
    },
    [INDEX.hunks]: {
      repo: { type: "keyword" },
      sha: { type: "keyword" },
      order: { type: "integer" },
      file: { type: "keyword" },
      file_text: { type: "text", analyzer: "code" },
      header: { type: "text", analyzer: "code" },
      text: { type: "text", analyzer: "code" },
      date: { type: "date" },
      ...vec,
    },
    [INDEX.logs]: {
      repo: { type: "keyword" },
      sha: { type: "keyword" },
      order: { type: "integer" },
      run_id: { type: "keyword" },
      status: { type: "keyword" },
      duration_ms: { type: "long" },
      date: { type: "date" },
      text: { type: "text", analyzer: "code" },
    },
    [INDEX.issues]: {
      repo: { type: "keyword" },
      number: { type: "integer" },
      title: { type: "text", analyzer: "code" },
      body: { type: "text", analyzer: "code" },
      comments: { type: "text", analyzer: "code" },
      author: { type: "keyword" },
      labels: { type: "keyword" },
      created: { type: "date" },
      ...vec,
    },
    [INDEX.cases]: {
      repo: { type: "keyword" },
      case_id: { type: "keyword" },
      description: { type: "text" },
      culprit: { type: "keyword" },
      probes: { type: "integer" },
      uniform_probes: { type: "integer" },
      prior_entropy_bits: { type: "float" },
      confidence: { type: "float" },
      created: { type: "date" },
      verdict: { type: "text" },
    },
  };

  for (const [name, properties] of Object.entries(defs)) {
    const exists = await client.indices.exists({ index: name });
    const doReset = reset && name !== INDEX.cases; // solved cases are history; never drop them on --reset
    if (exists && doReset) {
      await client.indices.delete({ index: name });
    }
    if (!exists || doReset) {
      await client.indices.create({
        index: name,
        settings: { number_of_shards: 1, number_of_replicas: 0, ...codeSettings },
        mappings: { properties: properties as never },
      });
    }
  }
}

export async function deleteRepo(repo: string): Promise<void> {
  const client = es();
  for (const idx of [INDEX.commits, INDEX.hunks, INDEX.logs, INDEX.issues]) {
    const exists = await client.indices.exists({ index: idx });
    if (!exists) continue;
    await client.deleteByQuery({ index: idx, query: { term: { repo } }, refresh: true, conflicts: "proceed" });
  }
}

export async function bulkIndex(index: string, docs: Record<string, unknown>[], idField?: string): Promise<void> {
  if (docs.length === 0) return;
  const client = es();
  const batch = 500;
  for (let i = 0; i < docs.length; i += batch) {
    const slice = docs.slice(i, i + batch);
    const operations = slice.flatMap((d) => [
      { index: { _index: index, ...(idField ? { _id: String(d[idField]) } : {}) } },
      d,
    ]);
    const res = await client.bulk({ operations, refresh: false });
    if (res.errors) {
      const first = res.items.find((it) => it.index?.error);
      const reason = first?.index?.error?.reason ?? JSON.stringify(first?.index?.error);
      if (/dimensions/.test(reason ?? "")) {
        throw new Error(`Embedding dimensions changed since the indices were created (${reason}). Re-run with --reset.`);
      }
      throw new Error(`Bulk index errors in ${index}: ${reason}`);
    }
  }
  await client.indices.refresh({ index });
}
