import fs from "node:fs/promises";
import { parseMarkdown } from "./parser.js";
import { KNOWLEDGE_DIR } from "./config.js";
import { normalizePathPrefix, resolveKnowledgePath } from "./path-utils.js";
import type {
  DocumentListItem,
  DocumentReadResult,
  ReadSectionResult,
  RelatedDocResult,
  RelatedMode,
  SuggestDocsOptions,
  SuggestDocsResult,
  SuggestedDocument,
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

interface RelatedDocRow {
  path: string;
  title: string;
  tags_json: string;
  updated_at: string;
}

interface SourceDocRow {
  id: number;
  path: string;
  title: string;
  tags_json: string;
  updated_at: string;
}

interface DocumentSummaryRow {
  path: string;
  title: string;
  tags_json: string;
  updated_at: string;
}

interface SuggestionCandidate {
  path: string;
  title: string;
  heading: string;
  anchor: string;
  updated_at: string;
  tags: string[];
  score: number;
  whyCodes: Set<string>;
}

const TASK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "when",
  "with"
]);

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

function escapeFtsPhrase(value: string): string {
  return value.replace(/"/g, "\"\"");
}

function buildFtsOrQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return "";
  }

  const phrases = [...trimmed.matchAll(/"([^"]+)"/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);

  const withoutPhrases = trimmed.replace(/"[^"]+"/g, " ");
  const words = withoutPhrases.match(/[A-Za-z0-9_]+/g) ?? [];

  const orderedUnique = new Set<string>();
  for (const phrase of phrases) {
    orderedUnique.add(phrase);
  }
  for (const word of words) {
    orderedUnique.add(word);
  }

  const terms = [...orderedUnique].filter(Boolean);
  if (terms.length === 0) {
    return "";
  }

  return terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ");
}

function normalizeAnchor(anchor: string): string {
  return anchor.trim().replace(/^#/, "").toLowerCase();
}

function sectionMarkdown(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`.trim();
}

function extractTaskTerms(task: string): string[] {
  const seen = new Set<string>();
  const parts = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.length < 2 || TASK_STOP_WORDS.has(part)) {
      continue;
    }

    seen.add(part);
    if (seen.size >= 12) {
      break;
    }
  }

  return [...seen];
}

function textMatchesTerms(text: string, terms: string[]): string[] {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term));
}

function ftsBoost(rawScore: number): number {
  if (!Number.isFinite(rawScore)) {
    return 0;
  }

  const safeScore = rawScore < 0 ? 0 : rawScore;
  return 90 / (1 + safeScore);
}

function recencyBoost(updatedAt: string): { score: number; reasonCode?: string } {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) {
    return { score: 0 };
  }

  const daysOld = Math.max(0, (Date.now() - updated) / (1000 * 60 * 60 * 24));
  const score = Math.max(0, 8 - Math.min(8, daysOld / 7));
  if (daysOld > 21) {
    return { score };
  }

  return {
    score,
    reasonCode: `recent_update:${new Date(updated).toISOString().slice(0, 10)}`
  };
}

function matchesFilters(path: string, tags: string[], pathPrefix?: string, wantedTags: string[] = []): boolean {
  if (pathPrefix && !path.startsWith(pathPrefix)) {
    return false;
  }

  if (wantedTags.length === 0) {
    return true;
  }

  const tagSet = new Set(tags.map(normalizeTag));
  return wantedTags.every((tag) => tagSet.has(tag));
}

function sourceDirectoryPrefix(docPath: string): string {
  if (!docPath.includes("/")) {
    return "";
  }

  return docPath.slice(0, docPath.lastIndexOf("/") + 1);
}

function mapRelatedReasonToCodes(rawReason: string, sourcePath: string): string[] {
  if (rawReason === "linked_from_source") {
    return [`linked_from:${sourcePath}`];
  }

  if (rawReason === "links_to_source") {
    return [`links_to:${sourcePath}`];
  }

  if (rawReason === "same_subtree") {
    const subtree = sourceDirectoryPrefix(sourcePath);
    return subtree ? [`same_subtree:${subtree}`] : ["same_subtree:root"];
  }

  if (rawReason.startsWith("shared_tags:")) {
    const rawTags = rawReason.slice("shared_tags:".length);
    return rawTags
      .split(",")
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .map((tag) => `tag_overlap:${tag}`);
  }

  return [];
}

function composeWhyLine(reasonCodes: string[]): string {
  const parts: string[] = [];

  for (const code of reasonCodes) {
    if (code.startsWith("title_match:")) {
      parts.push(`title matches "${code.slice("title_match:".length)}"`);
      continue;
    }
    if (code.startsWith("heading_match:")) {
      parts.push(`heading matches "${code.slice("heading_match:".length)}"`);
      continue;
    }
    if (code.startsWith("tag_overlap:")) {
      parts.push(`tag overlap "${code.slice("tag_overlap:".length)}"`);
      continue;
    }
    if (code.startsWith("linked_from:")) {
      parts.push(`linked from ${code.slice("linked_from:".length)}`);
      continue;
    }
    if (code.startsWith("links_to:")) {
      parts.push(`links to ${code.slice("links_to:".length)}`);
      continue;
    }
    if (code.startsWith("same_subtree:")) {
      parts.push(`same subtree ${code.slice("same_subtree:".length)}`);
      continue;
    }
    if (code.startsWith("recent_update:")) {
      parts.push(`updated ${code.slice("recent_update:".length)}`);
      continue;
    }
    if (code === "fts_match") {
      parts.push("strong full-text match");
      continue;
    }
  }

  return parts.slice(0, 3).join("; ") || "ranked by lexical and metadata match";
}

function toSuggestedDocument(candidate: SuggestionCandidate): SuggestedDocument {
  const whyCodes = [...candidate.whyCodes];
  return {
    path: candidate.path,
    title: candidate.title,
    heading: candidate.heading,
    anchor: candidate.anchor,
    updated_at: candidate.updated_at,
    why_codes: whyCodes,
    why: composeWhyLine(whyCodes)
  };
}

function addOrUpdateCandidate(
  candidates: Map<string, SuggestionCandidate>,
  next: Omit<SuggestionCandidate, "score" | "whyCodes"> & { scoreDelta: number; reasonCodes: string[] }
): void {
  const existing = candidates.get(next.path);
  if (!existing) {
    candidates.set(next.path, {
      path: next.path,
      title: next.title,
      heading: next.heading,
      anchor: next.anchor,
      updated_at: next.updated_at,
      tags: next.tags,
      score: next.scoreDelta,
      whyCodes: new Set(next.reasonCodes)
    });
    return;
  }

  existing.score += next.scoreDelta;
  if (next.heading && existing.heading === existing.title && next.heading !== existing.heading) {
    existing.heading = next.heading;
    existing.anchor = next.anchor;
  }
  for (const code of next.reasonCodes) {
    existing.whyCodes.add(code);
  }
}

export function searchKnowledge(
  db: SqliteDatabase,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const matchQuery = buildFtsOrQuery(query);
  if (!matchQuery) {
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
      query: matchQuery,
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

export function suggestDocsForTask(
  db: SqliteDatabase,
  task: string,
  options: SuggestDocsOptions = {}
): SuggestDocsResult {
  const normalizedTask = task.trim();
  if (!normalizedTask) {
    return {
      task: normalizedTask,
      start_with: [],
      read_order: [],
      query_hints: []
    };
  }

  const limit = Math.max(1, Math.min(options.limit ?? 6, 20));
  const pathPrefix = options.pathPrefix ? normalizePathPrefix(options.pathPrefix) : undefined;
  const wantedTags = options.tags?.map(normalizeTag).filter(Boolean) ?? [];
  const taskTerms = extractTaskTerms(normalizedTask);
  const candidates = new Map<string, SuggestionCandidate>();

  const searchOptions: SearchOptions = {
    limit: Math.min(120, Math.max(limit * 5, 30)),
    maxPerDocument: 1
  };
  if (pathPrefix) {
    searchOptions.pathPrefix = pathPrefix;
  }
  if (wantedTags.length > 0) {
    searchOptions.tags = wantedTags;
  }

  const seedResults = searchKnowledge(db, normalizedTask, searchOptions);

  for (const result of seedResults) {
    if (!matchesFilters(result.path, result.tags, pathPrefix, wantedTags)) {
      continue;
    }

    const titleMatches = textMatchesTerms(result.title, taskTerms).slice(0, 2);
    const headingMatches = textMatchesTerms(result.heading, taskTerms).slice(0, 2);
    const tagMatches = result.tags.filter((tag) => wantedTags.includes(normalizeTag(tag))).slice(0, 2);
    const recency = recencyBoost(result.updated_at);

    const reasonCodes = new Set<string>(["fts_match"]);
    for (const match of titleMatches) {
      reasonCodes.add(`title_match:${match}`);
    }
    for (const match of headingMatches) {
      reasonCodes.add(`heading_match:${match}`);
    }
    for (const match of tagMatches) {
      reasonCodes.add(`tag_overlap:${normalizeTag(match)}`);
    }
    if (recency.reasonCode) {
      reasonCodes.add(recency.reasonCode);
    }

    const scoreDelta =
      ftsBoost(result.score) +
      titleMatches.length * 12 +
      headingMatches.length * 9 +
      tagMatches.length * 7 +
      recency.score;

    addOrUpdateCandidate(candidates, {
      path: result.path,
      title: result.title,
      heading: result.heading || result.title,
      anchor: result.anchor || "top",
      updated_at: result.updated_at,
      tags: result.tags,
      scoreDelta,
      reasonCodes: [...reasonCodes]
    });
  }

  const seedDocs = seedResults.slice(0, Math.min(8, Math.max(3, limit)));
  for (const seed of seedDocs) {
    const relatedDocs = listRelatedDocs(db, seed.path, {
      limit: Math.max(6, limit * 2),
      modes: ["links", "tags", "path"]
    });

    for (const related of relatedDocs) {
      if (!matchesFilters(related.path, related.tags, pathPrefix, wantedTags)) {
        continue;
      }

      const recency = recencyBoost(related.updated_at);
      const reasonCodes = new Set<string>(mapRelatedReasonToCodes(related.reasons[0] ?? "", seed.path));
      for (const reason of related.reasons.slice(1)) {
        for (const mapped of mapRelatedReasonToCodes(reason, seed.path)) {
          reasonCodes.add(mapped);
        }
      }
      if (recency.reasonCode) {
        reasonCodes.add(recency.reasonCode);
      }

      const scoreDelta = Math.min(30, related.score * 0.22) + recency.score;

      addOrUpdateCandidate(candidates, {
        path: related.path,
        title: related.title,
        heading: related.title,
        anchor: "top",
        updated_at: related.updated_at,
        tags: related.tags,
        scoreDelta,
        reasonCodes: [...reasonCodes]
      });
    }
  }

  if (candidates.size === 0) {
    const fallbackRows = db
      .prepare(`
        SELECT path, title, tags_json, updated_at
        FROM documents
        WHERE (@path_prefix IS NULL OR path LIKE @path_like)
        ORDER BY updated_at DESC
        LIMIT @raw_limit
      `)
      .all({
        path_prefix: pathPrefix ?? null,
        path_like: pathPrefix ? `${pathPrefix}%` : null,
        raw_limit: Math.max(20, limit * 6)
      }) as DocumentSummaryRow[];

    for (const row of fallbackRows) {
      const tags = parseTagsJson(row.tags_json);
      if (!matchesFilters(row.path, tags, pathPrefix, wantedTags)) {
        continue;
      }

      const recency = recencyBoost(row.updated_at);
      const reasonCodes = recency.reasonCode ? [recency.reasonCode] : [];

      addOrUpdateCandidate(candidates, {
        path: row.path,
        title: row.title,
        heading: row.title,
        anchor: "top",
        updated_at: row.updated_at,
        tags,
        scoreDelta: recency.score,
        reasonCodes
      });
    }
  }

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(toSuggestedDocument);

  const startWith = ranked.slice(0, Math.min(2, ranked.length));
  const hints = new Set<string>();

  if (taskTerms.length >= 2) {
    hints.add(taskTerms.slice(0, 2).join(" "));
  } else if (taskTerms.length === 1) {
    hints.add(taskTerms[0] ?? normalizedTask);
  }

  if (wantedTags.length > 0) {
    hints.add(`tags:${wantedTags.join(",")}`);
  }

  if (startWith[0]) {
    const firstHeading = startWith[0].heading.trim();
    if (firstHeading && firstHeading !== startWith[0].title) {
      hints.add(`${taskTerms[0] ?? normalizedTask} ${firstHeading}`.trim());
    }
  }

  return {
    task: normalizedTask,
    start_with: startWith,
    read_order: ranked,
    query_hints: [...hints].slice(0, 3)
  };
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

export async function readSectionFromDisk(
  relativePath: string,
  anchor: string,
  contextBefore = 0,
  contextAfter = 0
): Promise<ReadSectionResult> {
  const absolutePath = resolveKnowledgePath(KNOWLEDGE_DIR, relativePath);
  const [markdown, stat] = await Promise.all([
    fs.readFile(absolutePath, "utf8"),
    fs.stat(absolutePath)
  ]);

  const parsed = parseMarkdown(relativePath, markdown);
  const wantedAnchor = normalizeAnchor(anchor);
  const index = parsed.chunks.findIndex((chunk) => normalizeAnchor(chunk.anchor) === wantedAnchor);

  if (index === -1) {
    throw new Error(`Anchor not found in ${relativePath}: ${anchor}`);
  }

  const chunk = parsed.chunks[index];
  if (!chunk) {
    throw new Error(`Section lookup failed for ${relativePath}: ${anchor}`);
  }
  const beforeStart = Math.max(0, index - Math.max(0, contextBefore));
  const afterEnd = Math.min(parsed.chunks.length, index + 1 + Math.max(0, contextAfter));

  const context_before = parsed.chunks.slice(beforeStart, index).map((item) => ({
    heading: item.heading,
    anchor: item.anchor,
    markdown: sectionMarkdown(item.heading, item.body)
  }));

  const context_after = parsed.chunks.slice(index + 1, afterEnd).map((item) => ({
    heading: item.heading,
    anchor: item.anchor,
    markdown: sectionMarkdown(item.heading, item.body)
  }));

  return {
    path: normalizePathPrefix(relativePath),
    title: parsed.title,
    tags: parsed.tags,
    updated_at: stat.mtime.toISOString(),
    heading: chunk.heading,
    anchor: chunk.anchor,
    section_markdown: sectionMarkdown(chunk.heading, chunk.body),
    context_before,
    context_after
  };
}

export function listRelatedDocs(
  db: SqliteDatabase,
  sourcePath: string,
  options: { limit?: number; modes?: RelatedMode[] } = {}
): RelatedDocResult[] {
  const normalizedPath = normalizePathPrefix(sourcePath);
  const source = db
    .prepare(`
      SELECT id, path, title, tags_json, updated_at
      FROM documents
      WHERE path = ?
      LIMIT 1
    `)
    .get(normalizedPath) as SourceDocRow | undefined;

  if (!source) {
    return [];
  }

  const limit = options.limit ?? 10;
  const modes = new Set<RelatedMode>(options.modes?.length ? options.modes : ["links", "tags", "path"]);
  const scored = new Map<string, RelatedDocResult>();

  const addCandidate = (row: RelatedDocRow, scoreDelta: number, reason: string): void => {
    if (row.path === normalizedPath) {
      return;
    }

    const existing = scored.get(row.path);
    if (existing) {
      existing.score += scoreDelta;
      if (!existing.reasons.includes(reason)) {
        existing.reasons.push(reason);
      }
      return;
    }

    scored.set(row.path, {
      path: row.path,
      title: row.title,
      tags: parseTagsJson(row.tags_json),
      updated_at: row.updated_at,
      score: scoreDelta,
      reasons: [reason]
    });
  };

  if (modes.has("links")) {
    const outgoing = db
      .prepare(`
        SELECT d.path, d.title, d.tags_json, d.updated_at
        FROM document_links l
        JOIN documents d ON d.path = l.target_path
        WHERE l.source_document_id = ?
      `)
      .all(source.id) as RelatedDocRow[];

    for (const row of outgoing) {
      addCandidate(row, 100, "linked_from_source");
    }

    const incoming = db
      .prepare(`
        SELECT d.path, d.title, d.tags_json, d.updated_at
        FROM document_links l
        JOIN documents d ON d.id = l.source_document_id
        WHERE l.target_path = ?
      `)
      .all(normalizedPath) as RelatedDocRow[];

    for (const row of incoming) {
      addCandidate(row, 60, "links_to_source");
    }
  }

  if (modes.has("tags")) {
    const sourceTags = new Set(parseTagsJson(source.tags_json));
    if (sourceTags.size > 0) {
      const allOther = db
        .prepare(`
          SELECT path, title, tags_json, updated_at
          FROM documents
          WHERE path != ?
        `)
        .all(normalizedPath) as RelatedDocRow[];

      for (const row of allOther) {
        const tags = parseTagsJson(row.tags_json);
        const overlap = tags.filter((tag) => sourceTags.has(tag));
        if (overlap.length > 0) {
          addCandidate(row, overlap.length * 10, `shared_tags:${overlap.slice(0, 3).join(",")}`);
        }
      }
    }
  }

  if (modes.has("path")) {
    const sourceDir = normalizedPath.includes("/")
      ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
      : "";

    if (sourceDir) {
      const nearby = db
        .prepare(`
          SELECT path, title, tags_json, updated_at
          FROM documents
          WHERE path != ? AND path LIKE ?
        `)
        .all(normalizedPath, `${sourceDir}%`) as RelatedDocRow[];

      for (const row of nearby) {
        addCandidate(row, 4, "same_subtree");
      }
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
    .slice(0, Math.max(1, limit));
}
