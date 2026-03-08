import { KNOWLEDGE_DIR } from "./config.js";
import { openDatabase } from "./db.js";
import { startKnowledgeWatcher } from "./watcher.js";

async function main(): Promise<void> {
  const db = openDatabase();
  const watcher = await startKnowledgeWatcher(db, KNOWLEDGE_DIR);

  const shutdown = async (): Promise<void> => {
    await watcher.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[watch] Fatal error", error);
  process.exit(1);
});
