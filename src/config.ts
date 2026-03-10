import path from "node:path";

/**
 * Centralized runtime configuration.
 * Each value reads from an environment variable first and otherwise falls back to
 * a default. Path-like env values are normalized with `path.resolve(...)`.
 */
const projectRoot = process.cwd();

/** Absolute project root used as the base for default relative paths. */
export const PROJECT_ROOT = projectRoot;
/**
 * Knowledge markdown directory.
 * Env: `KNOWLEDGE_DIR`
 * Default: `<PROJECT_ROOT>/knowledge`
 * Parsing: if set, resolved to an absolute path with `path.resolve(...)`.
 */
export const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR
  ? path.resolve(process.env.KNOWLEDGE_DIR)
  : path.join(projectRoot, "knowledge");
/**
 * Runtime data directory.
 * Env: `DATA_DIR`
 * Default: `<PROJECT_ROOT>/data`
 * Parsing: if set, resolved to an absolute path with `path.resolve(...)`.
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, "data");
/**
 * SQLite database file path.
 * Env: `DB_PATH`
 * Default: `<DATA_DIR>/knowledge.db`
 * Parsing: if set, resolved to an absolute path with `path.resolve(...)`.
 */
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "knowledge.db");
/**
 * Web UI HTTP port.
 * Env: `WEB_PORT`
 * Default: `3030`
 * Parsing: coerced with `Number(...)`.
 */
export const WEB_PORT = Number(process.env.WEB_PORT ?? "3030");
/**
 * MCP HTTP bind host.
 * Env: `MCP_HTTP_HOST`
 * Default: `127.0.0.1`
 */
export const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
/**
 * MCP HTTP bind port.
 * Env: `MCP_HTTP_PORT`
 * Default: `3000`
 * Parsing: coerced with `Number(...)`.
 */
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT ?? "3000");
/**
 * Optional API key for MCP HTTP authentication.
 * Env: `MCP_API_KEY`
 * Default: `undefined` (authentication key not set).
 */
export const MCP_API_KEY = process.env.MCP_API_KEY;
/**
 * MCP action log path.
 * Env: `MCP_ACTION_LOG_PATH`
 * Default: `<DATA_DIR>/mcp-actions.jsonl`
 * Parsing: if set, resolved to an absolute path with `path.resolve(...)`.
 */
export const MCP_ACTION_LOG_PATH = process.env.MCP_ACTION_LOG_PATH
  ? path.resolve(process.env.MCP_ACTION_LOG_PATH)
  : path.join(DATA_DIR, "mcp-actions.jsonl");
/**
 * MCP write-tool audit log path.
 * Env: `MCP_WRITE_AUDIT_LOG_PATH`
 * Default: `<DATA_DIR>/mcp-write-audit.jsonl`
 * Parsing: if set, resolved to an absolute path with `path.resolve(...)`.
 */
export const MCP_WRITE_AUDIT_LOG_PATH = process.env.MCP_WRITE_AUDIT_LOG_PATH
  ? path.resolve(process.env.MCP_WRITE_AUDIT_LOG_PATH)
  : path.join(DATA_DIR, "mcp-write-audit.jsonl");
/**
 * Controls whether MCP write tools are enabled.
 * Env: `MCP_ENABLE_WRITE_TOOLS`
 * Default: enabled
 * Semantics: disabled only when the env value is exactly `"0"`.
 */
export const MCP_ENABLE_WRITE_TOOLS = process.env.MCP_ENABLE_WRITE_TOOLS !== "0";
