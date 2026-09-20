import { es, INDEX } from "./client.js";
import { getEmbedder, jinaRerank } from "../embed.js";

export type EvidenceKind = "commit" | "hunk" | "ci-log" | "issue";

export interface Evidence {
  kind: EvidenceKind;
  id: string;
  score: number; // fused score (higher = more relevant)
  sha?: string;
  order?: number;
  title: string;
  snippet: string;
  file?: string;
  date?: string;
  /** which retrievers surfaced this document */
  via: string[];
}

interface RankedHit {
  id: string;
  source: Record<string, unknown>;
  index: string;
  highlights?: string[];
}

const HIGHLIGHT: import("@elastic/elasticsearch/lib/api/types").SearchHighlight = {
  fields: { "*": {} },
  fragment_size: 180,
  number_of_fragments: 3,
  pre_tags: ["«"],
  post_tags: ["»"],
  require_field_match: false,
};

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

const RRF_K = 60;

/**
 * Hybrid retrieval: BM25 (multi_match over code-analyzed fields) + kNN over dense vectors,
 * fused with Reciprocal Rank Fusion, then optionally reranked with Jina's cross-encoder.
 */
export async function searchEvidence(
  repo: string,
  query: string,
  opts: { size?: number; kinds?: EvidenceKind[]; rerank?: boolean } = {},
): Promise<Evidence[]> {
  const size = opts.size ?? 12;
  const kinds = opts.kinds ?? ["hunk", "commit", "ci-log", "issue"];
  const embedder = getEmbedder();
  const client = es();

  const qvec = embedder ? (await embedder.embed([query], "query"))[0] : null;
  const perIndex = Math.max(size * 2, 20);

  const fused = new Map<string, { hit: RankedHit; score: number; via: Set<string> }>();
  const fuse = (hits: RankedHit[], via: string) => {
    hits.forEach((h, rank) => {
      const key = `${h.index}/${h.id}`;
      const cur = fused.get(key) ?? { hit: h, score: 0, via: new Set<string>() };
      if (h.highlights?.length && !cur.hit.highlights?.length) cur.hit = { ...cur.hit, highlights: h.highlights };
      cur.score += 1 / (RRF_K + rank + 1);
      cur.via.add(via);
      fused.set(key, cur);
    });
  };

  const kindToIndex: Record<EvidenceKind, string> = {
    commit: INDEX.commits,
    hunk: INDEX.hunks,
    "ci-log": INDEX.logs,
    issue: INDEX.issues,
  };
  const bm25Fields: Record<EvidenceKind, string[]> = {
    commit: ["subject^3", "message^2", "files_text"],
    hunk: ["text^2", "file_text^2", "header"],
    "ci-log": ["text"],
    issue: ["title^3", "body^2", "comments"],
  };
  const hasVector: Record<EvidenceKind, boolean> = { commit: true, hunk: true, issue: true, "ci-log": false };

  await Promise.all(
    kinds.map(async (kind) => {
      const index = kindToIndex[kind];
      // CI logs are long and noisy: require a real overlap with the query and no fuzzy matching,
      // otherwise every log matches on boilerplate. Code/commit text gets forgiving matching.
      const strict = kind === "ci-log";
      const bm25 = await client.search({
        index,
        size: perIndex,
        query: {
          bool: {
            filter: [{ term: { repo } }],
            must: [
              {
                multi_match: {
                  query,
                  fields: bm25Fields[kind],
                  type: strict ? "most_fields" : "best_fields",
                  ...(strict ? { minimum_should_match: "3<60%" } : { fuzziness: "AUTO", prefix_length: 2 }),
                },
              },
            ],
          },
        },
        _source_excludes: ["embedding"],
        highlight: HIGHLIGHT,
      });
      fuse(
        bm25.hits.hits.map((h) => ({
          id: h._id!,
          source: h._source as Record<string, unknown>,
          index,
          highlights: Object.values(h.highlight ?? {}).flat(),
        })),
        "bm25",
      );

      if (qvec && hasVector[kind]) {
        const knn = await client.search({
          index,
          size: perIndex,
          knn: {
            field: "embedding",
            query_vector: qvec,
            k: perIndex,
            num_candidates: perIndex * 5,
            filter: { term: { repo } },
          },
          _source_excludes: ["embedding"],
        });
        fuse(
          knn.hits.hits.map((h) => ({ id: h._id!, source: h._source as Record<string, unknown>, index })),
          "knn",
        );
      }
    }),
  );

  let ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(size * 3, 30));

  let evidence = ranked.map(({ hit, score, via }) => toEvidence(hit, score, [...via]));

  if (opts.rerank !== false) {
    const reranked = await jinaRerank(query, evidence.map(evidenceText), size);
    if (reranked) {
      evidence = reranked.map((r) => ({ ...evidence[r.index], score: r.score, via: [...evidence[r.index].via, "rerank"] }));
    }
  }
  return evidence.slice(0, size);
}

function evidenceText(e: Evidence): string {
  return `${e.title}\n${e.snippet}`;
}

function toEvidence(hit: RankedHit, score: number, via: string[]): Evidence {
  const s = hit.source;
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : undefined);
  const num = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : undefined);
  switch (hit.index) {
    case INDEX.commits:
      return {
        kind: "commit",
        id: hit.id,
        score,
        sha: str("sha"),
        order: num("order"),
        title: `${str("short")} ${str("subject")}`,
        snippet: `${str("message") ?? ""}\nfiles: ${(s.files as string[] | undefined)?.join(", ") ?? ""}`.trim(),
        date: str("date"),
        via,
      };
    case INDEX.hunks:
      return {
        kind: "hunk",
        id: hit.id,
        score,
        sha: str("sha"),
        order: num("order"),
        file: str("file"),
        title: `${str("sha")?.slice(0, 7)} ${str("file")} ${str("header") ?? ""}`.trim(),
        snippet: (str("text") ?? "").slice(0, 1200),
        date: str("date"),
        via,
      };
    case INDEX.logs: {
      const hl = (hit.highlights ?? []).map(stripAnsi).map((s) => s.trim()).filter(Boolean);
      return {
        kind: "ci-log",
        id: hit.id,
        score,
        sha: str("sha"),
        order: num("order"),
        title: `CI run ${str("run_id")} (${str("status")}) @ ${str("sha")?.slice(0, 7)}`,
        snippet: hl.length ? hl.join("\n") : stripAnsi(str("text") ?? "").slice(0, 1200),
        date: str("date"),
        via,
      };
    }
    default:
      return {
        kind: "issue",
        id: hit.id,
        score,
        title: `Issue #${num("number")}: ${str("title")}`,
        snippet: `${str("body") ?? ""}\n---\n${str("comments") ?? ""}`.slice(0, 1500),
        date: str("created"),
        via,
      };
  }
}

/** Commits that touched a file, over time (terms + date_histogram aggregation). */
export async function fileTimeline(repo: string, file: string) {
  const res = await es().search({
    index: INDEX.commits,
    size: 50,
    query: { bool: { filter: [{ term: { repo } }, { term: { files: file } }] } },
    sort: [{ order: "asc" }],
    _source: ["sha", "short", "order", "subject", "author", "date", "insertions", "deletions"],
    aggs: {
      by_week: { date_histogram: { field: "date", calendar_interval: "week" } },
      authors: { terms: { field: "author.keyword", size: 10 } },
    },
  });
  return {
    commits: res.hits.hits.map((h) => h._source as Record<string, unknown>),
    weeks: ((res.aggregations?.by_week as { buckets: { key_as_string: string; doc_count: number }[] })?.buckets ?? []).map(
      (b) => ({ week: b.key_as_string, commits: b.doc_count }),
    ),
    authors: ((res.aggregations?.authors as { buckets: { key: string; doc_count: number }[] })?.buckets ?? []).map(
      (b) => ({ author: b.key, commits: b.doc_count }),
    ),
  };
}

/** Churn hotspots: which files changed most (terms agg with sub-aggregations). */
export async function churnHotspots(repo: string, size = 10) {
  const res = await es().search({
    index: INDEX.commits,
    size: 0,
    query: { term: { repo } },
    aggs: {
      files: {
        terms: { field: "files", size },
        aggs: { last_touched: { max: { field: "date" } }, authors: { cardinality: { field: "author.keyword" } } },
      },
    },
  });
  const buckets = (res.aggregations?.files as {
    buckets: { key: string; doc_count: number; last_touched: { value_as_string: string }; authors: { value: number } }[];
  }).buckets;
  return buckets.map((b) => ({
    file: b.key,
    commits: b.doc_count,
    authors: b.authors.value,
    lastTouched: b.last_touched.value_as_string,
  }));
}

/** CI health over time via ES|QL. */
export async function ciTimeline(repo: string): Promise<{ week: string; runs: number; failed: number; p50_ms: number }[]> {
  const q = `FROM ${INDEX.logs}
| WHERE repo == "${repo.replace(/"/g, '\\"')}"
| EVAL week = DATE_TRUNC(1 week, date)
| STATS runs = COUNT(*), failed = COUNT(*) WHERE status == "failed", p50_ms = PERCENTILE(duration_ms, 50) BY week
| SORT week ASC`;
  const res = (await es().esql.query({ query: q })) as unknown as { columns: { name: string }[]; values: unknown[][] };
  const cols = res.columns.map((c) => c.name);
  return res.values.map((row) => {
    const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    return {
      week: String(obj.week),
      runs: Number(obj.runs),
      failed: Number(obj.failed),
      p50_ms: Math.round(Number(obj.p50_ms ?? 0)),
    };
  });
}

export async function getCommit(repo: string, sha: string) {
  const res = await es().search({
    index: INDEX.commits,
    size: 1,
    query: { bool: { filter: [{ term: { repo } }, { prefix: { sha } }] } },
    _source_excludes: ["embedding"],
  });
  return (res.hits.hits[0]?._source as Record<string, unknown> | undefined) ?? null;
}

export async function getHunks(repo: string, sha: string) {
  const res = await es().search({
    index: INDEX.hunks,
    size: 100,
    query: { bool: { filter: [{ term: { repo } }, { prefix: { sha } }] } },
    _source_excludes: ["embedding"],
  });
  return res.hits.hits.map((h) => h._source as { file: string; header: string; text: string });
}

export async function listCases(repo?: string) {
  const exists = await es().indices.exists({ index: INDEX.cases });
  if (!exists) return [];
  const res = await es().search({
    index: INDEX.cases,
    size: 50,
    query: repo ? { term: { repo } } : { match_all: {} },
    sort: [{ created: "desc" }],
  });
  return res.hits.hits.map(
    (h) =>
      h._source as {
        repo: string;
        case_id: string;
        description: string;
        culprit: string;
        probes: number;
        uniform_probes: number;
        prior_entropy_bits: number;
        confidence: number;
        created: string;
      },
  );
}

/** sha -> CI status for every indexed CI run of the repo (first run per commit wins). */
export async function listCiStatus(repo: string): Promise<Map<string, "passed" | "failed">> {
  const out = new Map<string, "passed" | "failed">();
  try {
    const res = await es().search({
      index: INDEX.logs,
      size: 5000,
      query: { term: { repo } },
      sort: [{ order: "asc" }],
      _source: ["sha", "status"],
    });
    for (const h of res.hits.hits) {
      const s = h._source as { sha: string; status: string };
      if (!out.has(s.sha)) out.set(s.sha, s.status === "failed" ? "failed" : "passed");
    }
  } catch {
    /* logs index may not exist */
  }
  return out;
}

export async function listCommits(repo: string): Promise<{ sha: string; short: string; order: number; subject: string; author: string; date: string; files: string[] }[]> {
  const res = await es().search({
    index: INDEX.commits,
    size: 5000,
    query: { term: { repo } },
    sort: [{ order: "asc" }],
    _source: ["sha", "short", "order", "subject", "author", "date", "files"],
  });
  return res.hits.hits.map((h) => h._source as never);
}
