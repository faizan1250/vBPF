import { z } from "zod";

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().min(1).default("127.0.0.1"),
    AGENT_URL: z.string().url().default("http://127.0.0.1:8787"),
    AGENT_TOKEN_FILE: z.string().min(1).default("./run/agent.token"),
    WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),
    DATABASE_PATH: z.string().min(1).default("./run/api.sqlite3"),
    RECIPES_DIR: z.string().min(1).default("./recipes"),
    LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
    LLM_MODE: z.enum(["mock", "live"]).default("mock"),
  })
  .strict();

export type ApiConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return EnvSchema.parse({
    PORT: env["PORT"],
    HOST: env["HOST"],
    AGENT_URL: env["AGENT_URL"],
    AGENT_TOKEN_FILE: env["AGENT_TOKEN_FILE"],
    WEB_ORIGIN: env["WEB_ORIGIN"],
    DATABASE_PATH: env["DATABASE_PATH"],
    RECIPES_DIR: env["RECIPES_DIR"],
    LLM_MODEL: env["LLM_MODEL"],
    LLM_MODE: env["LLM_MODE"],
  });
}
