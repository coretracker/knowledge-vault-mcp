import fs from "node:fs/promises";
import { parseMarkdown } from "./parser.js";
import { KNOWLEDGE_DIR } from "./config.js";
import { normalizePathPrefix, resolveKnowledgePath } from "./path-utils.js";
import type {
  DocumentListItem,
  DocumentReadResult,
  SearchOptions,
  SearchResult
} from "./types.js";
import type { SqliteDatabase } from "./db.js";

interface SearchRow {
  path: string;
  title: string;
  tags_json: string;
  heading: string;
  anchor: string;
  updated_at: string;
  snippet: string;
  score: number;
}

function parseTagsJson(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed)
      ? parsed.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function searchKnowledge(
  db: SqliteDatabase,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const limit = options.limit ?? 10;
  const maxPerDocument = options.maxPerDocument ?? 2;
  const pathPrefix = options.pathPrefix ? normalizePathPrefix(options.pathPrefix) : undefined;
  const wantedTags = options.tags?.map(normalizeTag).filter(Boolean) ?? [];

  const sql = `
    SELECT
      d.path,
      d.title,
      d.tags_json,
      c.heading,
      c.anchor,
      c.updated_at,
      snippet(chunks_fts, 3, '<mark>', '</mark>', ' … ', 18) AS snippet,
      bm25(chunks_fts, 1.0, 0.8, 0.7, 1.2) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.document_id
    WHERE chunks_fts MATCH @query
      AND (@path_prefix IS NULL OR d.path LIKE @path_like)
    ORDER BY score ASC
    LIMIT @raw_limit
  `;

  const rawRows = db
    .prepare(sql)
    .all({
      query: normalizedQuery,
      path_prefix: pathPrefix ?? null,
      path_like: pathPrefix ? `${pathPrefix}%` : null,
      raw_limit: Math.max(limit * 6, 50)
    }) as SearchRow[];

  const filteredRows = wantedTags.length
    ? rawRows.filter((row) => {
        const docTags = parseTagsJson(row.tags_json);
        return wantedTags.every((tag) => docTags.includes(tag));
      })
    : rawRows;

  const perDocCounts = new Map<string, number>();
  const results: SearchResult[] = [];

  for (const row of filteredRows) {
    const used = perDocCounts.get(row.path) ?? 0;
    if (used >= maxPerDocument) {
      continue;
    }

    perDocCounts.set(row.path, used + 1);
    results.push({
      path: row.path,
      title: row.title,
      tags: parseTagsJson(row.tags_json),
      heading: row.heading,
      anchor: row.anchor,
      snippet: row.snippet,
      updated_at: row.updated_at,
      score: row.score
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

export function listDocs(db: SqliteDatabase, pathPrefix?: string): DocumentListItem[] {
  const normalizedPrefix = pathPrefix ? normalizePathPrefix(pathPrefix) : undefined;

  const rows = db
    .prepare(`
      SELECT path, title, tags_json, updated_at
      FROM documents
      WHERE (@path_prefix IS NULL OR path LIKE @path_like)
      ORDER BY path ASC
    `)
    .all({
      path_prefix: normalizedPrefix ?? null,
      path_like: normalizedPrefix ? `${normalizedPrefix}%` : null
    }) as Array<{
    path: string;
    title: string;
    tags_json: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    path: row.path,
    title: row.title,
    tags: parseTagsJson(row.tags_json),
    updated_at: row.updated_at
  }));
}

export function listRecentChanges(db: SqliteDatabase, limit = 20): DocumentListItem[] {
  const rows = db
    .prepare(`
      SELECT path, title, tags_json, updated_at
      FROM documents
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    path: string;
    title: string;
    tags_json: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    path: row.path,
    title: row.title,
    tags: parseTagsJson(row.tags_json),
    updated_at: row.updated_at
  }));
}

export async function readDocumentFromDisk(relativePath: string): Promise<DocumentReadResult> {
  const absolutePath = resolveKnowledgePath(KNOWLEDGE_DIR, relativePath);
  const [markdown, stat] = await Promise.all([
    fs.readFile(absolutePath, "utf8"),
    fs.stat(absolutePath)
  ]);

  const parsed = parseMarkdown(relativePath, markdown);

  return {
    path: normalizePathPrefix(relativePath),
    title: parsed.title,
    tags: parsed.tags,
    headings: parsed.headings,
    frontmatter: parsed.frontmatter,
    updated_at: stat.mtime.toISOString(),
    markdown
  };
}
