#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli.js");
if (existsSync(dist)) {
  await import(dist);
} else {
  // Dev fallback: run the TypeScript sources through tsx.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(here, "..", "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
