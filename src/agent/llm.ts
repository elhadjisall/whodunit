import { config } from "../config.js";

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";

type GeminiPart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
};

type GeminiContent = { role?: string; parts: GeminiPart[] };

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: TArgs) => Promise<string>;
}

export interface ToolLoopResult {
  finalText: string;
  toolCalls: { name: string; args: Record<string, unknown>; result: string }[];
  usage: { prompt: number; completion: number };
}

export function hasLLM(): boolean {
  return !!config.geminiApiKey;
}

/**
 * Brains, in order of preference. Free-tier quotas are per model, so when the primary model is
 * out of quota (429 with a per-day / free-tier quota message) we fall through to the next one
 * instead of stalling a live case. Override with GEMINI_FALLBACK_MODELS=a,b,c.
 */
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.5-flash,gemini-3-flash-preview,gemini-2.5-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
let activeModel = config.geminiModel;

export function llmLabel(): string {
  return hasLLM() ? `Gemini ${activeModel}` : "none (heuristic)";
}

/** Listener for retry chatter (rate limits, 5xx, model fallbacks) so a UI can show why the detective is pausing. */
let retryListener: ((text: string) => void) | null = null;
export function onLlmRetry(fn: ((text: string) => void) | null): void {
  retryListener = fn;
}

class QuotaExhausted extends Error {
  constructor(public readonly model: string, message: string) {
    super(message);
  }
}

/** A 429 whose message points at an exhausted (not merely bursting) quota — waiting will not help. */
function isHardQuota(status: number, message: string): boolean {
  return status === 429 && /free_tier|per_day|PerDay|daily|exceeded your current quota/i.test(message);
}

export async function geminiFetch(url: string, apiKey: string, body: unknown, what: string, opts: { failFastOnQuota?: boolean } = {}): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; details?: { "@type"?: string; retryDelay?: string }[] } };
    if (res.ok) return json;
    last = json.error?.message ?? res.statusText;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 7) throw new Error(`${what} failed: ${res.status} ${last}`);
    // A daily quota wall: give the caller a chance to switch model after one confirming retry.
    if (opts.failFastOnQuota && attempt >= 1 && isHardQuota(res.status, last)) throw new QuotaExhausted(url, last);
    const hinted = json.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const sec = hinted ? Math.max(1, parseInt(hinted, 10) || 0) : Math.min(60, 2 ** attempt * 2);
    const quota = last.match(/limit: \d+[^\n]*/)?.[0];
    retryListener?.(`${what} ${res.status === 429 ? "rate-limited" : `HTTP ${res.status}`}${quota ? ` (${quota.trim()})` : ""} — retry ${attempt + 1}/7 in ${sec + 1}s`);
    await new Promise((r) => setTimeout(r, (sec + 1) * 1000));
  }
  throw new Error(`${what} failed: ${last}`);
}

async function geminiGenerate(body: Record<string, unknown>): Promise<{
  content: GeminiContent;
  text: string;
  usage: { prompt: number; completion: number };
}> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set — the detective needs a brain.");
  const candidates = [activeModel, ...FALLBACK_MODELS.filter((m) => m !== activeModel)];
  type GenerateResponse = {
    error?: { message: string };
    candidates?: { content?: GeminiContent; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  let json: GenerateResponse | null = null;
  for (let i = 0; i < candidates.length && !json; i++) {
    const model = candidates[i];
    const url = `${GEMINI_ROOT}/models/${model}:generateContent`;
    try {
      json = (await geminiFetch(url, config.geminiApiKey, body, `Gemini ${model}`, { failFastOnQuota: i < candidates.length - 1 })) as GenerateResponse;
      if (model !== activeModel) {
        activeModel = model;
        retryListener?.(`brain switched to ${model} for the rest of this session`);
      }
    } catch (e) {
      if (!(e instanceof QuotaExhausted)) throw e;
      retryListener?.(`${model} is out of quota — falling back to ${candidates[i + 1]}`);
    }
  }
  if (!json) throw new Error("Gemini failed: every configured model is out of quota");
  const content = json.candidates?.[0]?.content ?? { role: "model", parts: [] };
  const text = (content.parts ?? []).map((p) => p.text ?? "").join("");
  return {
    content,
    text,
    usage: {
      prompt: json.usageMetadata?.promptTokenCount ?? 0,
      completion: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function declarations(tools: ToolDef<never>[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Generic tool-calling loop against Gemini 3.x. Thought signatures on model parts are
 * preserved and sent back — Gemini 3 requires that for multi-turn function calling.
 */
export async function runToolLoop(
  system: string,
  user: string,
  tools: ToolDef<never>[],
  opts: { maxTurns?: number; onToolCall?: (name: string, args: Record<string, unknown>) => void } = {},
): Promise<ToolLoopResult> {
  const maxTurns = opts.maxTurns ?? 12;
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: user }] }];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls: ToolLoopResult["toolCalls"] = [];
  const usage = { prompt: 0, completion: 0 };

  for (let turn = 0; turn < maxTurns; turn++) {
    const lastTurn = turn === maxTurns - 1;
    const reply = await geminiGenerate({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: tools.length ? [{ functionDeclarations: declarations(tools) }] : undefined,
      toolConfig: lastTurn ? { functionCallingConfig: { mode: "NONE" } } : { functionCallingConfig: { mode: "AUTO" } },
    });
    usage.prompt += reply.usage.prompt;
    usage.completion += reply.usage.completion;
    contents.push({ role: "model", parts: reply.content.parts ?? [] });

    const fnParts = (reply.content.parts ?? []).filter((p) => p.functionCall?.name);
    if (fnParts.length === 0) return { finalText: reply.text, toolCalls: calls, usage };

    const responseParts: GeminiPart[] = [];
    for (const part of fnParts) {
      const fc = part.functionCall!;
      const args = (fc.args ?? {}) as Record<string, unknown>;
      opts.onToolCall?.(fc.name, args);
      const tool = byName.get(fc.name);
      let result: string;
      try {
        result = tool ? await tool.handler(args as never) : `unknown tool ${fc.name}`;
      } catch (e) {
        result = `tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
      calls.push({ name: fc.name, args, result });
      responseParts.push({
        functionResponse: {
          name: fc.name,
          id: fc.id,
          response: { result: result.slice(0, 30_000) },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return { finalText: "", toolCalls: calls, usage };
}

export async function chatJSON<T>(system: string, user: string): Promise<T> {
  const reply = await geminiGenerate({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json" },
  });
  const text = reply.text.trim() || "{}";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 ? text.slice(start, end + 1) : text) as T;
}

export async function chatText(system: string, user: string): Promise<string> {
  const reply = await geminiGenerate({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
  });
  return reply.text;
}
