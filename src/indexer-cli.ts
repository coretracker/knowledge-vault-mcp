import { KNOWLEDGE_DIR } from "./config.js";
import { openDatabase } from "./db.js";
import { indexKnowledgeBase } from "./indexer.js";

async function main(): Promise<void> {
  const db = openDatabase();

  try {
    const stats = await indexKnowledgeBase(db, KNOWLEDGE_DIR);
    console.log(
      `[index] scanned=${stats.scannedFiles} upserted_files=${stats.upsertedFiles} upserted_chunks=${stats.upsertedChunks} removed=${stats.removedFiles}`
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("[index] Fatal error", error);
  process.exit(1);
});
