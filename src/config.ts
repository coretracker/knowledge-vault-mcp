import path from "node:path";

/**
 * Central runtime configuration derived from environment variables and the
 * current working directory. Path-based exports are normalized to absolute
 * paths when this module loads.
 */
const projectRoot = process.cwd();

/**
 * Current working directory captured from `process.cwd()` at module load.
 * This is the base for the default path-based config values in this module.
 */
export const PROJECT_ROOT = projectRoot;

/**
 * Absolute path to the Markdown knowledge directory.
 * Uses `KNOWLEDGE_DIR` when set, otherwise defaults to `<PROJECT_ROOT>/knowledge`.
 */
export const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  ? path.resolve(process.env.KNOWLEDGE_DIR)
  : path.join(projectRoot, "knowledge");

/**
 * Absolute path to the runtime data directory.
 * Uses `DATA_DIR` when set, otherwise defaults to `<PROJECT_ROOT>/data`.
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, "data");

/**
 * Absolute path to the SQLite database file.
 * Uses `DB_PATH` when set, otherwise defaults to `<DATA_DIR>/knowledge.db`.
 */
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "knowledge.db");

/**
 * Port for the web UI server.
 * Parsed from `WEB_PORT` with `Number()` and defaults to `3030` when unset.
 * Invalid numeric input is not validated here and can produce `NaN`.
 */
export const WEB_PORT = Number(process.env.WEB_PORT ?? "3030");

/**
 * Host interface for the MCP HTTP server.
 * Uses `MCP_HTTP_HOST` when set, otherwise defaults to `127.0.0.1`.
 */
export const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";

/**
 * Port for the MCP HTTP server.
 * Parsed from `MCP_HTTP_PORT` with `Number()` and defaults to `3000` when unset.
 * Invalid numeric input is not validated here and can produce `NaN`.
 */
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT ?? "3000");

/**
 * Optional shared secret for MCP HTTP authentication.
 * Reads `MCP_API_KEY` directly; when unset, this export remains `undefined`.
 */
export const MCP_API_KEY = process.env.MCP_API_KEY;

/**
 * Absolute path to the JSONL log of MCP actions.
 * Uses `MCP_ACTION_LOG_PATH` when set, otherwise defaults to
 * `<DATA_DIR>/mcp-actions.jsonl`.
 */
export const MCP_ACTION_LOG_PATH = process.env.MCP_ACTION_LOG_PATH
  ? path.resolve(process.env.MCP_ACTION_LOG_PATH)
  : path.join(DATA_DIR, "mcp-actions.jsonl");

/**
 * Absolute path to the JSONL audit log for write-capable MCP tools.
 * Uses `MCP_WRITE_AUDIT_LOG_PATH` when set, otherwise defaults to
 * `<DATA_DIR>/mcp-write-audit.jsonl`.
 */
export const MCP_WRITE_AUDIT_LOG_PATH = process.env.MCP_WRITE_AUDIT_LOG_PATH
  ? path.resolve(process.env.MCP_WRITE_AUDIT_LOG_PATH)
  : path.join(DATA_DIR, "mcp-write-audit.jsonl");

/**
 * Feature flag for write-capable MCP tools such as `create_note`.
 * Any value other than the exact string `"0"` enables the tools, matching
 * `MCP_ENABLE_WRITE_TOOLS !== "0"`.
 */
export const MCP_ENABLE_WRITE_TOOLS = process.env.MCP_ENABLE_WRITE_TOOLS !== "0";
