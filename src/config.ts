import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadEnvFiles() {
  const files = [path.join(process.cwd(), ".env"), path.join(os.homedir(), ".whodunit", ".env")];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
loadEnvFiles();

export interface Config {
  esUrl: string;
  esApiKey?: string;
  geminiApiKey?: string;
  geminiModel: string;
  openaiApiKey?: string;
  jinaApiKey?: string;
  embedProvider: "jina" | "gemini" | "openai" | "none";
  homeDir: string;
  indexPrefix: string;
}

export function loadConfig(): Config {
  const geminiApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const jinaApiKey = process.env.JINA_API_KEY;
  let embedProvider: Config["embedProvider"] = "none";
  const forced = process.env.WHODUNIT_EMBED as Config["embedProvider"] | undefined;
  if (forced) embedProvider = forced;
  else if (jinaApiKey) embedProvider = "jina";
  else if (geminiApiKey) embedProvider = "gemini";
  else if (openaiApiKey) embedProvider = "openai";

  return {
    esUrl: process.env.ELASTICSEARCH_URL ?? process.env.ES_URL ?? "http://127.0.0.1:9200",
    esApiKey: process.env.ELASTICSEARCH_API_KEY ?? process.env.ES_API_KEY,
    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
    openaiApiKey,
    jinaApiKey,
    embedProvider,
    homeDir: process.env.WHODUNIT_HOME ?? path.join(os.homedir(), ".whodunit"),
    indexPrefix: process.env.WHODUNIT_INDEX_PREFIX ?? "wd",
  };
}

export const config = loadConfig();
