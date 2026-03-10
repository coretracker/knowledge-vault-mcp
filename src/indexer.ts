import fs from "node:fs/promises";
import path from "node:path";
import { parseMarkdown } from "./parser.js";
import { isMarkdownPath, normalizeRelativePath } from "./path-utils.js";
import {
  listAllDocumentPaths,
  removeDocumentByPath,
  type SqliteDatabase,
  upsertDocumentWithChunks
} from "./db.js";
import type { IndexStats } from "./types.js";

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && isMarkdownPath(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function indexSingleFile(
  db: SqliteDatabase,
  absolutePath: string,
  knowledgeRoot: string
): Promise<{ relativePath: string; chunkCount: number }> {
  const relativePath = normalizeRelativePath(knowledgeRoot, absolutePath);

  const [stat, markdown] = await Promise.all([
    fs.stat(absolutePath),
    fs.readFile(absolutePath, "utf8")
  ]);

  const parsed = parseMarkdown(relativePath, markdown);
  const updatedAt = stat.mtime.toISOString();

  const result = upsertDocumentWithChunks(db, {
    path: relativePath,
    title: parsed.title,
    tags: parsed.tags,
    updatedAt,
    mtimeMs: stat.mtimeMs,
    chunks: parsed.chunks,
    links: parsed.links
  });

  return { relativePath, chunkCount: result.chunkCount };
}

export function removeMissingDocument(db: SqliteDatabase, relativePath: string): number {
  return removeDocumentByPath(db, relativePath);
}

export async function indexKnowledgeBase(db: SqliteDatabase, knowledgeRoot: string): Promise<IndexStats> {
  const stats: IndexStats = {
    scannedFiles: 0,
    upsertedFiles: 0,
    removedFiles: 0,
    upsertedChunks: 0
  };

  const absoluteFiles = await walkMarkdownFiles(knowledgeRoot);
  absoluteFiles.sort((a, b) => a.localeCompare(b));

  const seen = new Set<string>();

  for (const absoluteFile of absoluteFiles) {
    const { relativePath, chunkCount } = await indexSingleFile(db, absoluteFile, knowledgeRoot);
    seen.add(relativePath);
    stats.scannedFiles += 1;
    stats.upsertedFiles += 1;
    stats.upsertedChunks += chunkCount;
  }

  const knownPaths = listAllDocumentPaths(db);
  for (const existingPath of knownPaths) {
    if (!seen.has(existingPath)) {
      stats.removedFiles += removeDocumentByPath(db, existingPath);
    }
  }

  return stats;
}
