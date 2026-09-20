import os from "node:os";
import path from "node:path";

export interface Config {
  esUrl: string;
  esApiKey?: string;
  openaiApiKey?: string;
  openaiModel: string;
  jinaApiKey?: string;
  embedProvider: "jina" | "openai" | "none";
  homeDir: string;
  indexPrefix: string;
}

export function loadConfig(): Config {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const jinaApiKey = process.env.JINA_API_KEY;
  let embedProvider: Config["embedProvider"] = "none";
  const forced = process.env.WHODUNIT_EMBED as Config["embedProvider"] | undefined;
  if (forced) embedProvider = forced;
  else if (jinaApiKey) embedProvider = "jina";
  else if (openaiApiKey) embedProvider = "openai";

  return {
    esUrl: process.env.ELASTICSEARCH_URL ?? process.env.ES_URL ?? "http://127.0.0.1:9200",
    esApiKey: process.env.ELASTICSEARCH_API_KEY ?? process.env.ES_API_KEY,
    openaiApiKey,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1",
    jinaApiKey,
    embedProvider,
    homeDir: process.env.WHODUNIT_HOME ?? path.join(os.homedir(), ".whodunit"),
    indexPrefix: process.env.WHODUNIT_INDEX_PREFIX ?? "wd",
  };
}

export const config = loadConfig();
