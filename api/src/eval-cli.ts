import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrompts, renderMarkdown, runEval } from "./eval.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, "..", "..");
const recipesDir = join(repoRoot, "recipes");
const promptsPath = process.argv[2] ?? join(repoRoot, "eval", "prompts.yaml");
const reportsDir = join(repoRoot, "eval", "reports");

const entries = loadPrompts(promptsPath);
const { cases, summary, db } = await runEval(entries, {
  recipesDir,
  model: "mock",
});
db.close();

const date = new Date().toISOString().slice(0, 10);
mkdirSync(reportsDir, { recursive: true });
const outPath = process.argv[3] ?? join(reportsDir, `${date}.md`);
writeFileSync(outPath, renderMarkdown(date, "mock", summary, cases));
process.stdout.write(`${JSON.stringify(summary)}\n${outPath}\n`);
