import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import { z } from "zod";

import { RecipeSchema, type Recipe } from "@vbpf/schemas";

const YamlMetaSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
    view: z.string().min(1),
  })
  .passthrough();

export function loadRecipes(dir: string): Recipe[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith(".yaml") && !f.startsWith("_"),
    );
  } catch {
    return [];
  }
  const out: Recipe[] = [];
  for (const file of files.sort()) {
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const meta = YamlMetaSchema.parse(yaml.load(raw));
      out.push(
        RecipeSchema.parse({
          id: meta.id,
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          view: meta.view,
        }),
      );
    } catch {
      continue;
    }
  }
  return out;
}
