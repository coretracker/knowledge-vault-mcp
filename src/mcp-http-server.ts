import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { MCP_API_KEY, MCP_HTTP_HOST, MCP_HTTP_PORT } from "./config.js";
import { openDatabase } from "./db.js";
import { createMcpLogger, registerKnowledgeTools } from "./mcp-core.js";

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const app = createMcpExpressApp({ host: MCP_HTTP_HOST });
const db = openDatabase();
const logAction = createMcpLogger("mcp-http");
const sessions: Record<string, SessionEntry> = {};

app.disable("x-powered-by");

function getSessionId(req: Request): string | undefined {
  const raw = req.headers["mcp-session-id"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function getApiKeyHeader(req: Request): string | undefined {
  const header = req.headers["api_key"] ?? req.headers["x-api-key"] ?? req.headers["api-key"];
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

function isAuthorized(req: Request): boolean {
  if (!MCP_API_KEY) {
    return true;
  }

  return getApiKeyHeader(req) === MCP_API_KEY;
}

async function closeSession(sessionId: string): Promise<void> {
  const session = sessions[sessionId];
  if (!session) {
    return;
  }

  delete sessions[sessionId];

  try {
    await session.server.close();
  } catch (error) {
    logAction("session.close.error", {
      sessionId,
      message: (error as Error).message
    });
  }
}

app.all("/mcp", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    logAction("auth.denied", {
      method: req.method,
      path: req.path
    });

    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized"
      },
      id: null
    });
    return;
  }

  const method = req.method.toUpperCase();
  const sessionId = getSessionId(req);

  try {
    if (method === "POST") {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions[sessionId]) {
        transport = sessions[sessionId].transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const server = new McpServer({
          name: "markdown-knowledge-mcp",
          version: "0.1.0"
        });
        registerKnowledgeTools(server, db, logAction);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initializedSessionId) => {
            sessions[initializedSessionId] = { server, transport };
            logAction("session.initialized", {
              sessionId: initializedSessionId
            });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            void closeSession(sid);
            logAction("session.closed", { sessionId: sid });
          }
        };

        await server.connect(transport as unknown as Transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid MCP session"
          },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      if (!sessionId || !sessions[sessionId]) {
        res.status(400).send("Invalid or missing MCP session ID");
        return;
      }

      const transport = sessions[sessionId].transport;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(405).send("Method Not Allowed");
  } catch (error) {
    logAction("request.error", {
      method,
      sessionId: sessionId ?? null,
      message: (error as Error).message
    });

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: "mcp-http" });
});

const server = app.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, () => {
  logAction("ready", {
    url: `http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}/mcp`,
    apiKeyRequired: Boolean(MCP_API_KEY)
  });
});

const shutdown = async (signal: string): Promise<void> => {
  logAction("shutdown", {
    signal,
    openSessions: Object.keys(sessions).length
  });

  for (const sessionId of Object.keys(sessions)) {
    await closeSession(sessionId);
  }

  db.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
