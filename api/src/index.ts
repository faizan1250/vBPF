import "dotenv/config";

import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = loadConfig();

const app = await buildApp({
  agentUrl: config.AGENT_URL,
  tokenFile: config.AGENT_TOKEN_FILE,
  dbPath: config.DATABASE_PATH,
  recipesDir: config.RECIPES_DIR,
  webOrigin: config.WEB_ORIGIN,
  llmModel: config.LLM_MODEL,
  llmMode: config.LLM_MODE,
});

app.listen({ host: config.HOST, port: config.PORT }).catch((err: unknown) => {
  app.log.error({ err }, "api listen failed");
  process.exit(1);
});
