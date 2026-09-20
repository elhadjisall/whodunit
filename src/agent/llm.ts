import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "../config.js";

let _client: OpenAI | null = null;

export function hasLLM(): boolean {
  return !!config.openaiApiKey;
}

export function openai(): OpenAI {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set — the detective needs a brain.");
  return (_client ??= new OpenAI({ apiKey: config.openaiApiKey }));
}

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

/**
 * Generic tool-calling loop. The model may call tools as many times as it likes (bounded by
 * maxTurns); when it replies with plain text, the loop ends.
 */
export async function runToolLoop(
  system: string,
  user: string,
  tools: ToolDef<never>[],
  opts: { maxTurns?: number; onToolCall?: (name: string, args: Record<string, unknown>) => void } = {},
): Promise<ToolLoopResult> {
  const client = openai();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const toolSpecs: ChatCompletionTool[] = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls: ToolLoopResult["toolCalls"] = [];
  const usage = { prompt: 0, completion: 0 };

  for (let turn = 0; turn < (opts.maxTurns ?? 12); turn++) {
    const res = await client.chat.completions.create({
      model: config.openaiModel,
      messages,
      tools: toolSpecs,
      tool_choice: turn === (opts.maxTurns ?? 12) - 1 ? "none" : "auto",
    });
    usage.prompt += res.usage?.prompt_tokens ?? 0;
    usage.completion += res.usage?.completion_tokens ?? 0;
    const msg = res.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { finalText: msg.content ?? "", toolCalls: calls, usage };
    }
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const tool = byName.get(tc.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* keep {} */
      }
      opts.onToolCall?.(tc.function.name, args);
      let result: string;
      try {
        result = tool ? await tool.handler(args as never) : `unknown tool ${tc.function.name}`;
      } catch (e) {
        result = `tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
      calls.push({ name: tc.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 30_000) });
    }
  }
  return { finalText: "", toolCalls: calls, usage };
}

/** Ask for a JSON object and parse it. */
export async function chatJSON<T>(system: string, user: string): Promise<T> {
  const res = await openai().chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  });
  const text = res.choices[0].message.content ?? "{}";
  return JSON.parse(text) as T;
}

export async function chatText(system: string, user: string): Promise<string> {
  const res = await openai().chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0].message.content ?? "";
}
