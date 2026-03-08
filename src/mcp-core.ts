import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listDocs, listRecentChanges, readDocumentFromDisk, searchKnowledge } from "./search.js";
import type { SearchOptions } from "./types.js";
import type { SqliteDatabase } from "./db.js";

export interface McpActionLogger {
  (action: string, details?: Record<string, unknown>): void;
}

function toTextContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function previewQuery(query: string): string {
  const trimmed = query.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}...`;
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
        pathPrefix: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ query, limit, pathPrefix, tags }) => {
      logAction("search_knowledge.request", {
        query: previewQuery(query),
        limit: limit ?? null,
        pathPrefix: pathPrefix ?? null,
        tags: tags ?? []
      });

      const options: SearchOptions = {};
      if (limit !== undefined) {
        options.limit = limit;
      }
      if (pathPrefix !== undefined) {
        options.pathPrefix = pathPrefix;
      }
      if (tags !== undefined) {
        options.tags = tags;
      }

      const results = searchKnowledge(db, query, options);
      logAction("search_knowledge.response", {
        count: results.length
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
      logAction("read_doc.response", {
        path: document.path,
        title: document.title,
        markdownBytes: Buffer.byteLength(document.markdown, "utf8")
      });

      return toTextContent({
        path: document.path,
        title: document.title,
        tags: document.tags,
        updated_at: document.updated_at,
        frontmatter: document.frontmatter,
        headings: document.headings,
        markdown: document.markdown
      });
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
        count: documents.length
      });

      return toTextContent({
        count: documents.length,
        documents
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
        count: changes.length
      });

      return toTextContent({
        count: changes.length,
        changes
      });
    }
  );
}

export function createMcpLogger(prefix: string): McpActionLogger {
  return (action, details) => {
    const timestamp = new Date().toISOString();
    if (details) {
      // MCP protocol messages use stdout; diagnostics should go to stderr.
      console.error(`[${prefix}] ${timestamp} ${action} ${JSON.stringify(details)}`);
      return;
    }

    console.error(`[${prefix}] ${timestamp} ${action}`);
  };
}
