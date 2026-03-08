import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { indexKnowledgeBase, indexSingleFile, removeMissingDocument } from "./indexer.js";
import { isMarkdownPath, normalizeRelativePath } from "./path-utils.js";
import type { SqliteDatabase } from "./db.js";

interface WatchOptions {
  log?: (line: string) => void;
}

export async function startKnowledgeWatcher(
  db: SqliteDatabase,
  knowledgeRoot: string,
  options: WatchOptions = {}
): Promise<FSWatcher> {
  const log = options.log ?? ((line: string) => console.log(line));
  const usePolling = process.env.WATCH_USE_POLLING === "1";
  const pollInterval = Number(process.env.WATCH_POLL_INTERVAL ?? "300");

  const initialStats = await indexKnowledgeBase(db, knowledgeRoot);
  log(
    `[watch] Initial scan complete: ${initialStats.scannedFiles} scanned, ${initialStats.upsertedChunks} chunks indexed, ${initialStats.removedFiles} removed`
  );
  if (usePolling) {
    log(`[watch] Polling mode enabled (interval=${pollInterval}ms)`);
  }

  const watcher = chokidar.watch(knowledgeRoot, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 50
    },
    usePolling,
    interval: pollInterval,
    ignored: (watchedPath, stats) => {
      if (stats?.isFile()) {
        return !isMarkdownPath(watchedPath);
      }
      return false;
    }
  });

  let queue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch((error) => {
      log(`[watch] Error: ${(error as Error).message}`);
    });
  };

  watcher.on("add", (absolutePath) => {
    if (!isMarkdownPath(absolutePath)) {
      return;
    }

    enqueue(async () => {
      const { relativePath, chunkCount } = await indexSingleFile(db, absolutePath, knowledgeRoot);
      log(`[watch] added ${relativePath} (${chunkCount} chunks)`);
    });
  });

  watcher.on("change", (absolutePath) => {
    if (!isMarkdownPath(absolutePath)) {
      return;
    }

    enqueue(async () => {
      const { relativePath, chunkCount } = await indexSingleFile(db, absolutePath, knowledgeRoot);
      log(`[watch] updated ${relativePath} (${chunkCount} chunks)`);
    });
  });

  watcher.on("unlink", (absolutePath) => {
    if (!isMarkdownPath(absolutePath)) {
      return;
    }

    enqueue(async () => {
      const relativePath = normalizeRelativePath(knowledgeRoot, absolutePath);
      const removed = removeMissingDocument(db, relativePath);
      if (removed > 0) {
        log(`[watch] removed ${relativePath}`);
      }
    });
  });

  watcher.on("ready", () => {
    log("[watch] Watching for Markdown changes...");
  });

  watcher.on("error", (error) => {
    log(`[watch] Watcher error: ${(error as Error).message}`);
  });

  return watcher;
}
