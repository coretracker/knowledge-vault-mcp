import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import type { HeadingInfo, ParsedChunk, ParsedLink, ParsedMarkdownDocument } from "./types.js";

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

function parseInlineLinkTarget(rawTarget: string): { pathPart: string; anchor: string | null } | null {
  let target = rawTarget.trim();
  if (!target) {
    return null;
  }

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  } else {
    const firstWhitespace = target.search(/\s/);
    if (firstWhitespace !== -1) {
      target = target.slice(0, firstWhitespace).trim();
    }
  }

  if (!target) {
    return null;
  }

  const lowered = target.toLowerCase();
  if (
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("tel:") ||
    lowered.startsWith("data:")
  ) {
    return null;
  }

  if (target.startsWith("#")) {
    return { pathPart: "", anchor: target.slice(1) || null };
  }

  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) {
    return { pathPart: target, anchor: null };
  }

  return {
    pathPart: target.slice(0, hashIndex),
    anchor: target.slice(hashIndex + 1) || null
  };
}

function normalizeLinkedPath(sourceRelativePath: string, pathPart: string): string | null {
  const sourceDir = path.posix.dirname(sourceRelativePath.replace(/\\/g, "/"));
  const rawPath = pathPart.trim();
  if (!rawPath) {
    return sourceRelativePath.replace(/\\/g, "/");
  }

  const withoutQuery = rawPath.split("?")[0];
  if (!withoutQuery) {
    return null;
  }

  const normalized = withoutQuery.startsWith("/")
    ? path.posix.normalize(withoutQuery.replace(/^\/+/, ""))
    : path.posix.normalize(path.posix.join(sourceDir, withoutQuery));

  if (normalized.startsWith("../")) {
    return null;
  }

  const ext = path.posix.extname(normalized);
  if (!ext) {
    return `${normalized}.md`;
  }

  if (ext.toLowerCase() !== ".md") {
    return null;
  }

  return normalized;
}

function extractMarkdownLinks(sourceRelativePath: string, markdownBody: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const seen = new Set<string>();
  const linkPattern = /\[[^\]]*?\]\(([^)]+)\)/g;

  for (const match of markdownBody.matchAll(linkPattern)) {
    const rawTarget = (match[1] ?? "").trim();
    const parsed = parseInlineLinkTarget(rawTarget);
    if (!parsed) {
      continue;
    }

    const targetPath = normalizeLinkedPath(sourceRelativePath, parsed.pathPart);
    if (!targetPath) {
      continue;
    }

    const key = `${targetPath}#${parsed.anchor ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    links.push({
      rawTarget,
      targetPath,
      targetAnchor: parsed.anchor
    });
  }

  return links;
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
    links: extractMarkdownLinks(filePath, body),
    frontmatter: parsed.data as Record<string, unknown>,
    body
  };
}
