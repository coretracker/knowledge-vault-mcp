import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { createMcpLogger, registerKnowledgeTools } from "./mcp-core.js";

async function main(): Promise<void> {
  const db = openDatabase();
  const logAction = createMcpLogger("mcp-stdio");

  logAction("startup");

  const server = new McpServer({
    name: "markdown-knowledge-mcp",
    version: "0.1.0"
  });

  registerKnowledgeTools(server, db, logAction);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logAction("ready");

  const shutdown = async (signal: string): Promise<void> => {
    logAction("shutdown", { signal });
    await server.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[mcp-stdio] Fatal error", error);
  process.exit(1);
});
