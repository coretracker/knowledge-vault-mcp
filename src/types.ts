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

export interface ParsedMarkdownDocument {
  title: string;
  tags: string[];
  headings: HeadingInfo[];
  chunks: ParsedChunk[];
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
