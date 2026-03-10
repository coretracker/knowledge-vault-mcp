export interface HeadingInfo {
  depth: number;
  text: string;
  anchor: string;
}

export interface ParsedChunk {
  chunkIndex: number;
  heading: string;
  anchor: string;
  body: string;
}

export interface ParsedLink {
  rawTarget: string;
  targetPath: string;
  targetAnchor: string | null;
}

export interface ParsedMarkdownDocument {
  title: string;
  tags: string[];
  headings: HeadingInfo[];
  chunks: ParsedChunk[];
  links: ParsedLink[];
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface IndexStats {
  scannedFiles: number;
  upsertedFiles: number;
  removedFiles: number;
  upsertedChunks: number;
}

export interface SearchOptions {
  limit?: number;
  pathPrefix?: string;
  tags?: string[];
  maxPerDocument?: number;
}

export interface SuggestDocsOptions {
  limit?: number;
  pathPrefix?: string;
  tags?: string[];
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  heading: string;
  anchor: string;
  snippet: string;
  updated_at: string;
  score: number;
}

export interface DocumentListItem {
  path: string;
  title: string;
  tags: string[];
  updated_at: string;
}

export interface DocumentReadResult {
  path: string;
  title: string;
  tags: string[];
  headings: HeadingInfo[];
  frontmatter: Record<string, unknown>;
  updated_at: string;
  markdown: string;
}

export interface ReadSectionResult {
  path: string;
  title: string;
  tags: string[];
  updated_at: string;
  heading: string;
  anchor: string;
  section_markdown: string;
  context_before: Array<{ heading: string; anchor: string; markdown: string }>;
  context_after: Array<{ heading: string; anchor: string; markdown: string }>;
}

export type RelatedMode = "links" | "tags" | "path";

export interface RelatedDocResult {
  path: string;
  title: string;
  tags: string[];
  updated_at: string;
  score: number;
  reasons: string[];
}

export interface SuggestedDocument {
  path: string;
  title: string;
  heading: string;
  anchor: string;
  updated_at: string;
  why_codes: string[];
  why: string;
}

export interface SuggestDocsResult {
  task: string;
  start_with: SuggestedDocument[];
  read_order: SuggestedDocument[];
  query_hints: string[];
}
