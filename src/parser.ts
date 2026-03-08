import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import type { HeadingInfo, ParsedChunk, ParsedMarkdownDocument } from "./types.js";

interface MinimalToken {
  type: string;
  depth?: number;
  text?: string;
  raw?: string;
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return base || "section";
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

function extractTags(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  const rawTags = Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value)
        .split(",")
        .map((item) => item.trim());

  const deduped = new Set<string>();
  for (const rawTag of rawTags) {
    const tag = normalizeTag(rawTag);
    if (tag) {
      deduped.add(tag);
    }
  }

  return [...deduped];
}

function chooseTitle(frontmatterTitle: unknown, headings: HeadingInfo[], filePath: string): string {
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim()) {
    return frontmatterTitle.trim();
  }

  const h1 = headings.find((heading) => heading.depth === 1);
  if (h1) {
    return h1.text;
  }

  return path.basename(filePath, path.extname(filePath));
}

function tokenToRawMarkdown(token: MinimalToken): string {
  if (typeof token.raw === "string") {
    return token.raw;
  }

  if (typeof token.text === "string") {
    return token.text;
  }

  return "";
}

export function parseMarkdown(filePath: string, markdown: string): ParsedMarkdownDocument {
  const parsed = matter(markdown);
  const body = parsed.content;
  const tokens = marked.lexer(body, { gfm: true });

  const headings: HeadingInfo[] = [];
  const chunks: ParsedChunk[] = [];
  const slugCounts = new Map<string, number>();

  let currentHeading = "";
  let currentAnchor = "top";
  let currentParts: string[] = [];

  const nextAnchor = (headingText: string): string => {
    const base = slugify(headingText);
    const count = (slugCounts.get(base) ?? 0) + 1;
    slugCounts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };

  const flushChunk = (fallbackHeading: string): void => {
    const bodyContent = currentParts.join("").trim();
    if (!bodyContent && chunks.length > 0) {
      currentParts = [];
      return;
    }

    chunks.push({
      chunkIndex: chunks.length,
      heading: currentHeading || fallbackHeading,
      anchor: currentAnchor,
      body: bodyContent
    });

    currentParts = [];
  };

  for (const token of tokens as MinimalToken[]) {
    if (token.type === "heading") {
      const headingText = (token.text ?? "").trim();
      const anchor = nextAnchor(headingText);
      headings.push({ depth: token.depth ?? 1, text: headingText, anchor });

      if (currentParts.length > 0 || currentHeading) {
        flushChunk(headingText);
      }

      currentHeading = headingText;
      currentAnchor = anchor;
      continue;
    }

    currentParts.push(tokenToRawMarkdown(token));
  }

  const title = chooseTitle(parsed.data.title, headings, filePath);
  flushChunk(title);

  if (chunks.length === 0) {
    chunks.push({
      chunkIndex: 0,
      heading: title,
      anchor: "top",
      body: body.trim()
    });
  }

  return {
    title,
    tags: extractTags(parsed.data.tags ?? parsed.data.tag),
    headings,
    chunks,
    frontmatter: parsed.data as Record<string, unknown>,
    body
  };
}
