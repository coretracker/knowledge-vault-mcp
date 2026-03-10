import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listDocs,
  listRecentChanges,
  listRelatedDocs,
  readDocumentFromDisk,
  readSectionFromDisk,
  searchKnowledge
} from "./search.js";
import type { RelatedMode, SearchOptions } from "./types.js";
import type { SqliteDatabase } from "./db.js";
import {
  KNOWLEDGE_DIR,
  MCP_ACTION_LOG_PATH,
  MCP_ENABLE_WRITE_TOOLS,
  MCP_WRITE_AUDIT_LOG_PATH
} from "./config.js";
import { normalizePathPrefix, resolveKnowledgePath } from "./path-utils.js";

export interface McpActionLogger {
  (action: string, details?: unknown): void;
}

function toTextContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const deduped = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag) {
      deduped.add(tag);
    }
  }

  return [...deduped];
}

function ensureMarkdownRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("Path is required");
  }

  const normalized = normalizePathPrefix(trimmed).replace(/\/+/g, "/");
  if (!normalized) {
    throw new Error("Path is required");
  }
  if (normalized.endsWith("/")) {
    throw new Error("Path must include a filename");
  }

  const withExtension = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
  const fileName = path.posix.basename(withExtension);
  if (!fileName || fileName === ".md") {
    throw new Error("Path must include a valid markdown filename");
  }

  return withExtension;
}

function inferTitleFromPath(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath));
  const spaced = base.replace(/[_-]+/g, " ").trim();
  if (!spaced) {
    return "Untitled";
  }

  return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildMarkdownDocument(title: string, tags: string[], body: string): string {
  const frontmatter: string[] = [`title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`];

  if (tags.length > 0) {
    frontmatter.push("tags:");
    for (const tag of tags) {
      frontmatter.push(`  - "${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    }
  }

  const normalizedBody = body.trim();
  const contentBody = normalizedBody || `# ${title}`;
  return `---\n${frontmatter.join("\n")}\n---\n\n${contentBody}\n`;
}

function appendWriteAudit(action: string, details: unknown): void {
  fs.mkdirSync(path.dirname(MCP_WRITE_AUDIT_LOG_PATH), { recursive: true });

  const record = {
    at: new Date().toISOString(),
    action,
    details
  };

  try {
    fs.appendFileSync(MCP_WRITE_AUDIT_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(`[mcp-write] ${record.at} audit.write.error ${(error as Error).message}`);
  }
}

export function registerKnowledgeTools(server: McpServer, db: SqliteDatabase, logAction: McpActionLogger): void {
  server.registerTool(
    "search_knowledge",
    {
      title: "Search knowledge chunks",
      description: "Searches chunk-level Markdown content indexed in SQLite FTS5.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        maxPerDocument: z.number().int().min(1).max(10).optional(),
        pathPrefix: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ query, limit, maxPerDocument, pathPrefix, tags }) => {
      logAction("search_knowledge.request", {
        query,
        limit: limit ?? null,
        maxPerDocument: maxPerDocument ?? null,
        pathPrefix: pathPrefix ?? null,
        tags: tags ?? []
      });

      const options: SearchOptions = {};
      if (limit !== undefined) {
        options.limit = limit;
      }
      if (maxPerDocument !== undefined) {
        options.maxPerDocument = maxPerDocument;
      }
      if (pathPrefix !== undefined) {
        options.pathPrefix = pathPrefix;
      }
      if (tags !== undefined) {
        options.tags = tags;
      }

      const results = searchKnowledge(db, query, options);
      logAction("search_knowledge.response", {
        query,
        count: results.length,
        results
      });

      return toTextContent({
        query,
        count: results.length,
        results
      });
    }
  );

  server.registerTool(
    "read_doc",
    {
      title: "Read canonical Markdown file",
      description: "Reads full Markdown from disk for a specific path.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        path: z.string().min(1)
      }
    },
    async ({ path }) => {
      logAction("read_doc.request", { path });

      const document = await readDocumentFromDisk(path);
      const responsePayload = {
        path: document.path,
        title: document.title,
        tags: document.tags,
        updated_at: document.updated_at,
        frontmatter: document.frontmatter,
        headings: document.headings,
        markdown: document.markdown
      };
      logAction("read_doc.response", responsePayload);

      return toTextContent(responsePayload);
    }
  );

  server.registerTool(
    "read_section",
    {
      title: "Read section from canonical Markdown",
      description: "Reads one section (by anchor) from disk, with optional neighboring section context.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        path: z.string().min(1),
        anchor: z.string().min(1),
        contextBefore: z.number().int().min(0).max(5).optional(),
        contextAfter: z.number().int().min(0).max(5).optional()
      }
    },
    async ({ path, anchor, contextBefore, contextAfter }) => {
      logAction("read_section.request", {
        path,
        anchor,
        contextBefore: contextBefore ?? 0,
        contextAfter: contextAfter ?? 0
      });

      const section = await readSectionFromDisk(path, anchor, contextBefore ?? 0, contextAfter ?? 0);
      logAction("read_section.response", section);

      return toTextContent(section);
    }
  );

  server.registerTool(
    "list_docs",
    {
      title: "List indexed documents",
      description: "Lists known documents from SQLite index.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        pathPrefix: z.string().optional()
      }
    },
    async ({ pathPrefix }) => {
      logAction("list_docs.request", {
        pathPrefix: pathPrefix ?? null
      });

      const documents = listDocs(db, pathPrefix);
      logAction("list_docs.response", {
        count: documents.length,
        documents
      });

      return toTextContent({
        count: documents.length,
        documents
      });
    }
  );

  server.registerTool(
    "list_related_docs",
    {
      title: "List related documents",
      description: "Returns docs related by links, shared tags, and/or path proximity.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        path: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        modes: z.array(z.enum(["links", "tags", "path"])).optional()
      }
    },
    async ({ path, limit, modes }) => {
      logAction("list_related_docs.request", {
        path,
        limit: limit ?? 10,
        modes: modes ?? ["links", "tags", "path"]
      });

      const relatedOptions: { limit?: number; modes?: RelatedMode[] } = {};
      if (limit !== undefined) {
        relatedOptions.limit = limit;
      }
      if (modes !== undefined) {
        relatedOptions.modes = modes as RelatedMode[];
      }

      const related = listRelatedDocs(db, path, relatedOptions);
      logAction("list_related_docs.response", {
        path,
        count: related.length,
        related
      });

      return toTextContent({
        path,
        count: related.length,
        related
      });
    }
  );

  server.registerTool(
    "list_recent_changes",
    {
      title: "List recent document changes",
      description: "Returns most recently modified indexed documents.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ limit }) => {
      logAction("list_recent_changes.request", {
        limit: limit ?? 20
      });

      const changes = listRecentChanges(db, limit ?? 20);
      logAction("list_recent_changes.response", {
        count: changes.length,
        changes
      });

      return toTextContent({
        count: changes.length,
        changes
      });
    }
  );

  if (MCP_ENABLE_WRITE_TOOLS) {
    server.registerTool(
      "create_note",
      {
        title: "Create Markdown note",
        description: "Creates a new Markdown file under knowledge/ with frontmatter. Never overwrites files.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        },
        inputSchema: {
          path: z.string().min(1),
          title: z.string().min(1).max(200).optional(),
          tags: z.array(z.string().min(1).max(64)).max(30).optional(),
          body: z.string().max(200_000).optional(),
          dryRun: z.boolean().optional()
        }
      },
      async ({ path: requestedPath, title, tags, body, dryRun }) => {
        const dryRunEnabled = Boolean(dryRun);
        logAction("create_note.request", {
          path: requestedPath,
          title: title ?? null,
          tags: tags ?? [],
          bodyLength: body?.length ?? 0,
          dryRun: dryRunEnabled
        });

        try {
          const relativePath = ensureMarkdownRelativePath(requestedPath);
          const absolutePath = resolveKnowledgePath(KNOWLEDGE_DIR, relativePath);

          if (fs.existsSync(absolutePath)) {
            const payload = {
              ok: false,
              error: "File already exists",
              path: relativePath
            };
            logAction("create_note.response", payload);
            return toTextContent(payload);
          }

          const normalizedTags = normalizeTags(tags);
          const resolvedTitle = (title?.trim() || inferTitleFromPath(relativePath)).trim();
          const markdown = buildMarkdownDocument(resolvedTitle, normalizedTags, body ?? "");
          const dirPath = path.dirname(absolutePath);

          const payload = {
            ok: true,
            dryRun: dryRunEnabled,
            path: relativePath,
            title: resolvedTitle,
            tags: normalizedTags,
            bytes: Buffer.byteLength(markdown, "utf8"),
            preview: dryRunEnabled ? markdown : undefined
          };

          if (!dryRunEnabled) {
            fs.mkdirSync(dirPath, { recursive: true });
            fs.writeFileSync(absolutePath, markdown, { encoding: "utf8", flag: "wx" });
          }

          appendWriteAudit("create_note", {
            dryRun: dryRunEnabled,
            path: relativePath,
            title: resolvedTitle,
            tags: normalizedTags,
            bytes: payload.bytes
          });

          logAction("create_note.response", payload);
          return toTextContent(payload);
        } catch (error) {
          const payload = {
            ok: false,
            error: (error as Error).message
          };
          logAction("create_note.response", payload);
          appendWriteAudit("create_note.error", {
            path: requestedPath,
            dryRun: dryRunEnabled,
            error: payload.error
          });
          return toTextContent(payload);
        }
      }
    );
  }
}

export function createMcpLogger(prefix: string): McpActionLogger {
  fs.mkdirSync(path.dirname(MCP_ACTION_LOG_PATH), { recursive: true });

  return (action, details) => {
    const timestamp = new Date().toISOString();
    const record = {
      at: timestamp,
      prefix,
      action,
      details: details ?? null
    };

    try {
      fs.appendFileSync(MCP_ACTION_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[${prefix}] ${timestamp} log.write.error ${message}`);
    }

    if (details) {
      // MCP protocol messages use stdout; diagnostics should go to stderr.
      console.error(`[${prefix}] ${timestamp} ${action} ${JSON.stringify(details)}`);
      return;
    }

    console.error(`[${prefix}] ${timestamp} ${action}`);
  };
}
