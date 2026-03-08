import path from "node:path";

const projectRoot = process.cwd();

export const PROJECT_ROOT = projectRoot;
export const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  ? path.resolve(process.env.KNOWLEDGE_DIR)
  : path.join(projectRoot, "knowledge");
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, "data");
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "knowledge.db");
export const WEB_PORT = Number(process.env.WEB_PORT ?? "3030");
export const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT ?? "3000");
export const MCP_API_KEY = process.env.MCP_API_KEY;
