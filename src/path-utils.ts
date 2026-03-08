import path from "node:path";

export function normalizeRelativePath(rootDir: string, absolutePath: string): string {
  const relative = path.relative(rootDir, absolutePath);
  return relative.split(path.sep).join("/");
}

export function normalizePathPrefix(prefix: string): string {
  return prefix.replace(/\\\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".md";
}

export function resolveKnowledgePath(rootDir: string, relativePath: string): string {
  const normalized = normalizePathPrefix(relativePath);
  const absolute = path.resolve(rootDir, normalized);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;

  if (absolute !== rootDir && !absolute.startsWith(rootWithSep)) {
    throw new Error(`Path is outside knowledge directory: ${relativePath}`);
  }

  return absolute;
}
