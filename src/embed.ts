import OpenAI from "openai";
import { config } from "./config.js";
import { geminiFetch } from "./agent/llm.js";

/**
 * Embedding provider abstraction.
 *  - jina   : Jina dense vectors (jina-embeddings-v3, 1024 dims)
 *  - gemini : gemini-embedding-001 (768 dims) — default when GEMINI_API_KEY is set
 *  - openai : text-embedding-3-small (1536 dims)
 *  - none   : BM25-only mode
 */
export interface Embedder {
  name: string;
  dims: number;
  embed(texts: string[], task?: "passage" | "query"): Promise<number[][]>;
}

class JinaEmbedder implements Embedder {
  name = "jina-embeddings-v3";
  dims = 1024;
  constructor(private apiKey: string) {}
  async embed(texts: string[], task: "passage" | "query" = "passage"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
      const res = await fetch("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.name,
          task: task === "query" ? "retrieval.query" : "retrieval.passage",
          dimensions: this.dims,
          input: batch,
        }),
      });
      if (!res.ok) throw new Error(`Jina embeddings failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const sorted = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      out.push(...sorted);
    }
    return out;
  }
}

class GeminiEmbedder implements Embedder {
  name = "gemini-embedding-001";
  dims = 768;
  constructor(private apiKey: string) {}
  async embed(texts: string[], task: "passage" | "query" = "passage"): Promise<number[][]> {
    const out: number[][] = [];
    const taskType = task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8).map((t) => t.slice(0, 8000));
      const json = (await geminiFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.name}:batchEmbedContents`,
        this.apiKey,
        {
          requests: batch.map((text) => ({
            model: `models/${this.name}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: this.dims,
          })),
        },
        "Gemini embeddings",
      )) as { embeddings: { values: number[] }[] };
      out.push(...json.embeddings.map((e) => e.values));
      await new Promise((r) => setTimeout(r, 700));
    }
    return out;
  }
}

class OpenAIEmbedder implements Embedder {
  name = "text-embedding-3-small";
  dims = 1536;
  private client: OpenAI;
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
      const res = await this.client.embeddings.create({ model: this.name, input: batch });
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}

export function getEmbedder(): Embedder | null {
  switch (config.embedProvider) {
    case "jina":
      if (!config.jinaApiKey) throw new Error("WHODUNIT_EMBED=jina but JINA_API_KEY is not set");
      return new JinaEmbedder(config.jinaApiKey);
    case "gemini":
      if (!config.geminiApiKey) throw new Error("WHODUNIT_EMBED=gemini but GEMINI_API_KEY is not set");
      return new GeminiEmbedder(config.geminiApiKey);
    case "openai":
      if (!config.openaiApiKey) throw new Error("WHODUNIT_EMBED=openai but OPENAI_API_KEY is not set");
      return new OpenAIEmbedder(config.openaiApiKey);
    default:
      return null;
  }
}

export async function jinaRerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<{ index: number; score: number }[] | null> {
  if (!config.jinaApiKey || documents.length === 0) return null;
  const res = await fetch("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.jinaApiKey}` },
    body: JSON.stringify({
      model: "jina-reranker-v2-base-multilingual",
      query,
      documents: documents.map((d) => d.slice(0, 6000)),
      top_n: topN,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { results: { index: number; relevance_score: number }[] };
  return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
}
