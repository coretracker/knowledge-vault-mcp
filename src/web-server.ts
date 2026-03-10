import fs from "node:fs";
import express from "express";
import { KNOWLEDGE_DIR, MCP_ACTION_LOG_PATH, WEB_PORT } from "./config.js";
import { openDatabase } from "./db.js";
import { resolveKnowledgePath } from "./path-utils.js";
import {
  listDocs,
  listRecentChanges,
  listRelatedDocs,
  readDocumentFromDisk,
  readSectionFromDisk,
  searchKnowledge
} from "./search.js";
import type { SearchOptions, SearchResult } from "./types.js";

const app = express();
const db = openDatabase();
interface McpActionRecord {
  at: string;
  prefix: string;
  action: string;
  details: unknown;
}

interface McpRequestLogEntry {
  id: number;
  prefix: string;
  tool: string;
  request_at: string;
  response_at?: string;
  request: unknown;
  response: unknown;
  error?: string;
}

const DISPLAYED_MCP_TOOLS = new Set([
  "search_knowledge",
  "read_doc",
  "read_section",
  "list_docs",
  "list_related_docs",
  "list_recent_changes",
  "create_note"
]);

interface LogFilterInput {
  limit: number;
  tool?: string;
  prefix?: string;
  fromMs?: number;
  toMs?: number;
  contains?: string;
  onlyErrors: boolean;
}

interface LogQueryState {
  logLimit: number;
  logTool: string;
  logPrefix: string;
  logFrom: string;
  logTo: string;
  logContains: string;
  logOnlyErrors: boolean;
}

function readMcpActionRecords(maxLines = 5000): McpActionRecord[] {
  let raw = "";
  try {
    raw = fs.readFileSync(MCP_ACTION_LOG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const recentLines = lines.slice(-maxLines);
  const records: McpActionRecord[] = [];

  for (const line of recentLines) {
    try {
      const parsed = JSON.parse(line) as Partial<McpActionRecord>;
      if (
        typeof parsed.at === "string" &&
        typeof parsed.prefix === "string" &&
        typeof parsed.action === "string"
      ) {
        records.push({
          at: parsed.at,
          prefix: parsed.prefix,
          action: parsed.action,
          details: parsed.details ?? null
        });
      }
    } catch {
      // Ignore invalid lines in rolling log files.
    }
  }

  return records;
}

function extractLogError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const asRecord = payload as Record<string, unknown>;
  if (asRecord.ok === false) {
    const message = asRecord.error;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    return "operation_failed";
  }

  const errorValue = asRecord.error;
  if (typeof errorValue === "string" && errorValue.trim()) {
    return errorValue.trim();
  }

  if (errorValue && typeof errorValue === "object") {
    const nested = errorValue as Record<string, unknown>;
    if (typeof nested.message === "string" && nested.message.trim()) {
      return nested.message.trim();
    }
    return "error_payload";
  }

  return undefined;
}

function parseBooleanParam(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseDateToMs(input: string): number | undefined {
  if (!input.trim()) {
    return undefined;
  }

  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseLogQuery(query: Record<string, unknown>): LogQueryState {
  const logLimitInput = getStringParam(query.logLimit, "25");
  const logLimit = parseBoundedInt(logLimitInput, 25, 1, 500);

  return {
    logLimit,
    logTool: getStringParam(query.logTool),
    logPrefix: getStringParam(query.logPrefix),
    logFrom: getStringParam(query.logFrom),
    logTo: getStringParam(query.logTo),
    logContains: getStringParam(query.logContains),
    logOnlyErrors: parseBooleanParam(getStringParam(query.logOnlyErrors))
  };
}

function toLogFilterInput(state: LogQueryState): LogFilterInput {
  const filters: LogFilterInput = {
    limit: state.logLimit,
    onlyErrors: state.logOnlyErrors
  };

  const tool = state.logTool.trim();
  if (tool) {
    filters.tool = tool;
  }

  const prefix = state.logPrefix.trim();
  if (prefix) {
    filters.prefix = prefix;
  }

  const fromMs = parseDateToMs(state.logFrom);
  if (fromMs !== undefined) {
    filters.fromMs = fromMs;
  }

  const toMs = parseDateToMs(state.logTo);
  if (toMs !== undefined) {
    filters.toMs = toMs;
  }

  const contains = state.logContains.trim().toLowerCase();
  if (contains) {
    filters.contains = contains;
  }

  return filters;
}

function buildMcpRequestLogs(records: McpActionRecord[], filters: LogFilterInput): McpRequestLogEntry[] {
  const pendingByTool = new Map<string, Array<{ at: string; prefix: string; request: unknown }>>();
  const entries: McpRequestLogEntry[] = [];
  let id = 0;

  for (const record of records) {
    const match = record.action.match(/^(.*)\.(request|response)$/);
    if (!match) {
      continue;
    }

    const tool = match[1] ?? "";
    const phase = match[2] ?? "";
    if (!tool || (phase !== "request" && phase !== "response")) {
      continue;
    }
    if (!DISPLAYED_MCP_TOOLS.has(tool)) {
      continue;
    }

    if (phase === "request") {
      const queue = pendingByTool.get(tool) ?? [];
      queue.push({
        at: record.at,
        prefix: record.prefix,
        request: record.details
      });
      pendingByTool.set(tool, queue);
      continue;
    }

    const queue = pendingByTool.get(tool);
    const pending = queue?.shift();

    const error = extractLogError(record.details);
    const entry: McpRequestLogEntry = {
      id: ++id,
      prefix: pending?.prefix ?? record.prefix,
      tool,
      request_at: pending?.at ?? record.at,
      response_at: record.at,
      request: pending?.request ?? null,
      response: record.details
    };
    if (error) {
      entry.error = error;
    }

    entries.push(entry);
  }

  for (const [tool, queue] of pendingByTool.entries()) {
    for (const pending of queue) {
      entries.push({
        id: ++id,
        prefix: pending.prefix,
        tool,
        request_at: pending.at,
        request: pending.request,
        response: null,
        error: "no_response_yet"
      });
    }
  }

  const filtered = entries.filter((entry) => {
    if (filters.tool && entry.tool !== filters.tool) {
      return false;
    }

    if (filters.prefix && entry.prefix !== filters.prefix) {
      return false;
    }

    const eventMs = Date.parse(entry.response_at ?? entry.request_at);
    if (filters.fromMs !== undefined && Number.isFinite(eventMs) && eventMs < filters.fromMs) {
      return false;
    }
    if (filters.toMs !== undefined && Number.isFinite(eventMs) && eventMs > filters.toMs) {
      return false;
    }

    if (filters.onlyErrors && !entry.error) {
      return false;
    }

    if (filters.contains) {
      const haystack = JSON.stringify({
        tool: entry.tool,
        prefix: entry.prefix,
        request: entry.request,
        response: entry.response,
        error: entry.error ?? null
      }).toLowerCase();
      if (!haystack.includes(filters.contains)) {
        return false;
      }
    }

    return true;
  });

  const sortBy = (entry: McpRequestLogEntry): string => entry.response_at ?? entry.request_at;
  filtered.sort((a, b) => sortBy(b).localeCompare(sortBy(a)));

  return filtered.slice(0, filters.limit);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSnippet(snippet: string): string {
  const withTokens = snippet.replace(/<mark>/g, "__MARK_OPEN__").replace(/<\/mark>/g, "__MARK_CLOSE__");
  return escapeHtml(withTokens)
    .replace(/__MARK_OPEN__/g, "<mark>")
    .replace(/__MARK_CLOSE__/g, "</mark>");
}

function getStringParam(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return fallback;
}

function parseTags(input: string): string[] | undefined {
  const tags = input
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  return tags.length > 0 ? tags : undefined;
}

function parseBoundedInt(input: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function toUrlParams(query: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    const stringValue = getStringParam(value, "");
    if (stringValue) {
      params.set(key, stringValue);
    }
  }

  return params;
}

function linkWith(base: URLSearchParams, updates: Record<string, string | undefined>): string {
  const next = new URLSearchParams(base);

  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      next.delete(key);
      continue;
    }
    next.set(key, value);
  }

  const query = next.toString();
  return query ? `/?${query}` : "/";
}

function renderSelectOptions(values: string[], selected: string, allLabel: string): string {
  const options = [`<option value="">${escapeHtml(allLabel)}</option>`];
  for (const value of values) {
    const selectedAttr = value === selected ? ' selected="selected"' : "";
    options.push(`<option value="${escapeHtml(value)}"${selectedAttr}>${escapeHtml(value)}</option>`);
  }
  return options.join("");
}

function tagPills(tags: string[]): string {
  if (tags.length === 0) {
    return '<span class="chip muted-chip">no tags</span>';
  }

  return tags.slice(0, 6).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
}

function estimateTokens(value: unknown): { json: string; chars: number; tokens: number } {
  const json = JSON.stringify(value, null, 2);
  const chars = json.length;
  const tokens = Math.ceil(chars / 4);
  return { json, chars, tokens };
}

function renderJsonDebug(tool: string, input: unknown, output: unknown): string {
  const inputStats = estimateTokens(input);
  const outputStats = estimateTokens(output);

  return `
    <details class="debug-block">
      <summary>Raw JSON (${escapeHtml(tool)})</summary>
      <div class="debug-grid">
        <div>
          <p class="muted mini">request: ${String(inputStats.tokens)} tokens est (${String(inputStats.chars)} chars)</p>
          <pre>${escapeHtml(inputStats.json)}</pre>
        </div>
        <div>
          <p class="muted mini">response: ${String(outputStats.tokens)} tokens est (${String(outputStats.chars)} chars)</p>
          <pre>${escapeHtml(outputStats.json)}</pre>
        </div>
      </div>
    </details>
  `;
}

function searchResultCard(result: SearchResult, baseParams: URLSearchParams): string {
  const score = Number.isFinite(result.score) ? result.score.toFixed(2) : "n/a";
  const inspectLink = linkWith(baseParams, {
    tab: "context",
    viewPath: result.path,
    viewAnchor: result.anchor,
    relatedPath: result.path
  });

  return `
    <article class="result-card">
      <div class="result-head">
        <h3>${escapeHtml(result.title)}</h3>
        <span class="score-pill">score ${escapeHtml(score)}</span>
      </div>
      <div class="meta-row">
        <span class="mono">${escapeHtml(result.path)}</span>
        <span class="dot">•</span>
        <span>${escapeHtml(result.heading || "(top)")}</span>
        <span class="dot">•</span>
        <span>${escapeHtml(result.anchor)}</span>
      </div>
      <div class="snippet">${safeSnippet(result.snippet)}</div>
      <div class="chips">${tagPills(result.tags)}</div>
      <div class="action-row">
        <a class="btn ghost" href="${inspectLink}">Inspect</a>
      </div>
    </article>
  `;
}

function renderLogList(entries: McpRequestLogEntry[]): string {
  if (entries.length === 0) {
    return '<div class="empty">No MCP tool requests logged yet.</div>';
  }

  return `<div class="log-list">${entries
    .map((entry) => {
      const requestJson = JSON.stringify(entry.request, null, 2);
      const responseJson = JSON.stringify(entry.response, null, 2);
      const started = Date.parse(entry.request_at);
      const finished = entry.response_at ? Date.parse(entry.response_at) : Number.NaN;
      const durationMs =
        Number.isFinite(started) && Number.isFinite(finished) && finished >= started
          ? Math.round(finished - started)
          : null;

      return `<details class="log-item">
        <summary class="log-summary">
          <span class="log-title">${escapeHtml(entry.tool)}</span>
          <span class="chip">${escapeHtml(entry.prefix)}</span>
          <span class="mono">${escapeHtml(entry.request_at)}</span>
          <span class="score-pill">${durationMs !== null ? `${String(durationMs)} ms` : "pending"}</span>
          <span class="chip">#${String(entry.id)}</span>
          ${entry.error ? `<span class="badge warn">${escapeHtml(entry.error)}</span>` : ""}
        </summary>
        <div class="log-body">
          <section class="log-json">
            <p class="muted mini">request JSON</p>
            <pre>${escapeHtml(requestJson)}</pre>
          </section>
          <section class="log-json">
            <p class="muted mini">response JSON</p>
            <pre>${escapeHtml(responseJson)}</pre>
          </section>
        </div>
      </details>`;
    })
    .join("")}</div>`;
}

function pageLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700;800&display=swap");
      :root {
        --bg: #f8fafc;
        --bg-alt: #f1f5f9;
        --surface: #ffffff;
        --surface-strong: #f1f5f9;
        --stroke: #cbd5e1;
        --text: #0f172a;
        --muted: #475569;
        --accent: #3b82f6;
        --accent-strong: #2563eb;
        --success: #22c55e;
        --chip: #e2e8f0;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--text);
        font-family: "Space Grotesk", "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 15% -15%, rgba(59, 130, 246, 0.2) 0, rgba(59, 130, 246, 0) 50%),
          radial-gradient(circle at 92% -10%, rgba(15, 23, 42, 0.08) 0, rgba(15, 23, 42, 0) 40%),
          linear-gradient(180deg, var(--bg) 0%, var(--bg-alt) 100%);
        min-height: 100vh;
      }
      h1, h2, h3, p { margin: 0; }
      .page {
        max-width: 1260px;
        margin: 0 auto;
        padding: 14px;
        display: grid;
        gap: 12px;
      }
      .panel {
        background: var(--surface);
        border: 1px solid var(--stroke);
        border-radius: 14px;
        box-shadow: 0 6px 14px rgba(15, 23, 42, 0.08);
        padding: 12px;
        color: var(--text);
      }
      .hero {
        padding: 16px;
        background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%);
        color: var(--text);
      }
      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #64748b;
        margin-bottom: 6px;
        font-weight: 700;
      }
      h1 {
        font-size: 36px;
        line-height: 1.1;
        letter-spacing: -0.025em;
      }
      .subtitle {
        margin-top: 6px;
        color: var(--muted);
        font-size: 14px;
      }
      .hero .subtitle {
        color: var(--muted);
      }
      .tab-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .tab-link {
        border: 1px solid #64748b;
        border-radius: 999px;
        background: #0f172a;
        color: #e2e8f0;
        padding: 8px 12px;
        text-decoration: none;
        font-size: 13px;
        font-weight: 700;
      }
      .tab-link.active {
        border-color: var(--accent-strong);
        background: linear-gradient(180deg, var(--accent), var(--accent-strong));
        color: #effaf4;
      }
      .tab-panel {
        display: none;
      }
      .tab-panel.active {
        display: block;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.3fr 1fr;
        gap: 12px;
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: baseline;
        margin-bottom: 10px;
      }
      .panel-head h2 {
        font-size: 24px;
        letter-spacing: -0.02em;
      }
      .muted {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
      }
      .mini {
        font-size: 12px;
      }
      form {
        display: grid;
        gap: 8px;
      }
      .form-grid {
        display: grid;
        grid-template-columns: 1.6fr 1fr 1fr 110px auto;
        gap: 8px;
      }
      .form-to-result {
        margin-top: 18px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .field span {
        font-size: 11px;
        font-weight: 700;
        color: #475569;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      input {
        width: 100%;
        border: 1px solid #94a3b8;
        border-radius: 10px;
        background: #ffffff;
        color: #0f172a;
        padding: 10px 11px;
        font: inherit;
      }
      input:focus {
        outline: 2px solid rgba(59, 130, 246, 0.3);
        border-color: var(--accent);
      }
      select {
        width: 100%;
        border: 1px solid #94a3b8;
        border-radius: 10px;
        background: #ffffff;
        color: #0f172a;
        padding: 10px 11px;
        font: inherit;
      }
      select:focus {
        outline: 2px solid rgba(59, 130, 246, 0.3);
        border-color: var(--accent);
      }
      input[type="checkbox"] {
        width: auto;
        margin: 0;
      }
      button, .btn {
        border: 1px solid var(--accent-strong);
        border-radius: 10px;
        background: linear-gradient(180deg, var(--accent), var(--accent-strong));
        color: #effaf4;
        font-weight: 700;
        padding: 10px 12px;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        justify-content: center;
        align-items: center;
      }
      .btn.ghost {
        background: #f1f5f9;
        color: #334155;
        border-color: #94a3b8;
      }
      .split {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .accordion-list {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .accordion-item {
        border: 1px solid var(--stroke);
        border-radius: 11px;
        background: var(--surface-strong);
        overflow: hidden;
      }
      .accordion-summary {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: 10px;
        background: #e2e8f0;
        color: #0f172a;
        font-weight: 700;
      }
      .accordion-summary::-webkit-details-marker {
        display: none;
      }
      .accordion-item[open] .accordion-summary {
        border-bottom: 1px solid #475569;
      }
      .accordion-body {
        padding: 10px;
        display: grid;
        gap: 10px;
      }
      .table-wrap {
        border: 1px solid var(--stroke);
        border-radius: 10px;
        overflow: hidden;
        background: var(--surface-strong);
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th, td {
        border-bottom: 1px solid #cbd5e1;
        text-align: left;
        vertical-align: top;
        padding: 8px;
        font-size: 13px;
      }
      th {
        background: #0f172a;
        font-size: 12px;
        color: #cbd5e1;
      }
      .result-list {
        display: grid;
        gap: 8px;
      }
      .result-card {
        border: 1px solid var(--stroke);
        border-radius: 11px;
        background: var(--surface-strong);
        padding: 10px;
      }
      .result-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .result-head h3 {
        font-size: 17px;
      }
      .score-pill {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid #94a3b8;
        background: #e2e8f0;
        color: #334155;
      }
      .meta-row {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .mono {
        font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
      }
      .dot {
        opacity: 0.5;
      }
      .snippet {
        margin-top: 8px;
        font-size: 13px;
        line-height: 1.45;
      }
      .chips {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        font-size: 11px;
        border-radius: 999px;
        padding: 2px 7px;
        border: 1px solid #94a3b8;
        background: var(--chip);
        color: #334155;
      }
      .muted-chip {
        color: #64748b;
      }
      .action-row {
        margin-top: 8px;
        display: flex;
        gap: 8px;
      }
      .checkbox-field {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
      }
      .inline-actions {
        display: flex;
        gap: 8px;
        align-items: end;
      }
      .empty {
        border: 1px dashed #94a3b8;
        border-radius: 10px;
        padding: 12px;
        color: #334155;
        background: #f8fafc;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .status-card {
        border: 1px solid var(--stroke);
        border-radius: 10px;
        background: var(--surface-strong);
        padding: 10px;
      }
      .status-value {
        font-size: 28px;
        line-height: 1;
        margin-top: 4px;
      }
      .recent-list {
        display: grid;
        gap: 8px;
      }
      .recent-link {
        text-decoration: none;
        color: inherit;
        border: 1px solid var(--stroke);
        border-radius: 10px;
        padding: 8px;
        display: block;
        background: var(--surface-strong);
      }
      .recent-link:hover {
        border-color: #3b82f6;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 9px;
        font-size: 11px;
        border: 1px solid #22c55e;
        background: rgba(34, 197, 94, 0.18);
        color: #166534;
      }
      .badge.warn {
        border-color: #3b82f6;
        background: rgba(59, 130, 246, 0.2);
        color: #1d4ed8;
      }
      .debug-block {
        margin-top: 10px;
      }
      .debug-grid {
        margin-top: 8px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .log-list {
        display: grid;
        gap: 10px;
      }
      .log-item {
        border: 1px solid var(--stroke);
        border-radius: 11px;
        background: var(--surface-strong);
        overflow: hidden;
      }
      .log-summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        padding: 10px;
        background: #e2e8f0;
        color: #0f172a;
      }
      .log-summary::-webkit-details-marker {
        display: none;
      }
      .log-item[open] .log-summary {
        border-bottom: 1px solid #475569;
      }
      .log-title {
        font-weight: 700;
      }
      .log-body {
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .log-json {
        display: grid;
        gap: 6px;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        border-radius: 10px;
        border: 1px solid #94a3b8;
        background: #0b1220;
        color: #e2e8f0;
        padding: 10px;
        font-size: 12px;
        line-height: 1.45;
        font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
      }
      mark {
        background: #22c55e;
        color: #052e16;
        border-radius: 3px;
        padding: 0 2px;
      }
      @media (max-width: 1100px) {
        .grid, .split, .debug-grid {
          grid-template-columns: 1fr;
        }
        .form-grid {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 700px) {
        h1 { font-size: 30px; }
        .status-grid, .form-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">${body}</main>
  </body>
</html>`;
}

app.get("/", async (req, res) => {
  const queryParams = toUrlParams(req.query as Record<string, unknown>);

  const query = getStringParam(req.query.query);
  const searchPathPrefix = getStringParam(req.query.searchPathPrefix);
  const searchTagsInput = getStringParam(req.query.searchTags);
  const searchLimitInput = getStringParam(req.query.searchLimit, "12");
  const maxPerDocInput = getStringParam(req.query.maxPerDocument, "2");
  const searchLimit = parseBoundedInt(searchLimitInput, 12, 1, 50);
  const maxPerDocument = parseBoundedInt(maxPerDocInput, 2, 1, 10);
  const searchTags = parseTags(searchTagsInput);

  const viewPathParam = getStringParam(req.query.viewPath);
  const viewAnchorParam = getStringParam(req.query.viewAnchor);
  const contextBeforeInput = getStringParam(req.query.contextBefore, "1");
  const contextAfterInput = getStringParam(req.query.contextAfter, "1");
  const contextBefore = parseBoundedInt(contextBeforeInput, 1, 0, 5);
  const contextAfter = parseBoundedInt(contextAfterInput, 1, 0, 5);

  const relatedPathParam = getStringParam(req.query.relatedPath);
  const relatedLimitInput = getStringParam(req.query.relatedLimit, "8");
  const relatedLimit = parseBoundedInt(relatedLimitInput, 8, 1, 50);
  const logState = parseLogQuery(req.query as Record<string, unknown>);

  const docs = listDocs(db);
  const docsCount = docs.length;
  const recent = listRecentChanges(db, 8);

  const searchOptions: SearchOptions = {
    limit: searchLimit,
    maxPerDocument
  };
  if (searchPathPrefix) {
    searchOptions.pathPrefix = searchPathPrefix;
  }
  if (searchTags) {
    searchOptions.tags = searchTags;
  }

  const searchResults = query ? searchKnowledge(db, query, searchOptions) : [];

  const defaultViewPath = viewPathParam || searchResults[0]?.path || recent[0]?.path || "";
  const defaultViewAnchor = viewAnchorParam || searchResults[0]?.anchor || "top";

  let documentError = "";
  let sectionError = "";
  let documentView: Awaited<ReturnType<typeof readDocumentFromDisk>> | null = null;
  let sectionView: Awaited<ReturnType<typeof readSectionFromDisk>> | null = null;

  if (defaultViewPath) {
    try {
      documentView = await readDocumentFromDisk(defaultViewPath);
    } catch (error) {
      documentError = (error as Error).message;
    }
  }

  if (defaultViewPath && defaultViewAnchor && defaultViewAnchor !== "top") {
    try {
      sectionView = await readSectionFromDisk(defaultViewPath, defaultViewAnchor, contextBefore, contextAfter);
    } catch (error) {
      sectionError = (error as Error).message;
    }
  }

  const relatedPath = relatedPathParam || defaultViewPath;
  const related = relatedPath ? listRelatedDocs(db, relatedPath, { limit: relatedLimit, modes: ["links", "tags", "path"] }) : [];

  let fileExists = false;
  if (defaultViewPath) {
    try {
      fileExists = fs.existsSync(resolveKnowledgePath(KNOWLEDGE_DIR, defaultViewPath));
    } catch {
      fileExists = false;
    }
  }

  const searchResultHtml = searchResults.length
    ? `<div class="result-list">${searchResults.map((item) => searchResultCard(item, queryParams)).join("")}</div>`
    : `<div class="empty">${query ? "No results for current diagnostics query." : "Run diagnostics search to inspect scoring and snippets."}</div>`;

  const sectionHtml = sectionView
    ? `<article class="result-card">
        <div class="result-head"><h3>${escapeHtml(sectionView.heading)}</h3><span class="score-pill">#${escapeHtml(sectionView.anchor)}</span></div>
        <div class="meta-row"><span class="mono">${escapeHtml(sectionView.path)}</span></div>
        <pre style="margin-top:8px">${escapeHtml(sectionView.section_markdown)}</pre>
      </article>
      ${sectionView.context_before.length > 0 ? `<p class="muted" style="margin-top:8px">Before context</p><pre>${escapeHtml(
        sectionView.context_before.map((part) => part.markdown).join("\n\n")
      )}</pre>` : ""}
      ${sectionView.context_after.length > 0 ? `<p class="muted" style="margin-top:8px">After context</p><pre>${escapeHtml(
        sectionView.context_after.map((part) => part.markdown).join("\n\n")
      )}</pre>` : ""}`
    : defaultViewPath && defaultViewAnchor === "top"
      ? '<div class="empty">Anchor is <strong>top</strong>. Set a section anchor to test <code>read_section</code>.</div>'
      : sectionError
        ? `<div class="empty">${escapeHtml(sectionError)}</div>`
        : '<div class="empty">No section selected.</div>';

  const documentHtml = documentView
    ? `<article class="result-card">
        <div class="result-head"><h3>${escapeHtml(documentView.title)}</h3><span class="badge ${
          fileExists ? "" : "warn"
        }">${fileExists ? "exists on disk" : "missing on disk"}</span></div>
        <div class="meta-row"><span class="mono">${escapeHtml(documentView.path)}</span><span class="dot">•</span><span>${escapeHtml(
          documentView.updated_at
        )}</span></div>
        <div class="chips">${tagPills(documentView.tags)}</div>
      </article>
      <details class="debug-block" open>
        <summary>Full markdown</summary>
        <pre>${escapeHtml(documentView.markdown)}</pre>
      </details>`
    : documentError
      ? `<div class="empty">${escapeHtml(documentError)}</div>`
      : '<div class="empty">No document selected.</div>';

  const relatedHtml = related.length
    ? `<div class="result-list">${related
        .map((item) => {
          const inspectLink = linkWith(queryParams, {
            tab: "context",
            viewPath: item.path,
            viewAnchor: "top",
            relatedPath: item.path
          });
          return `<article class="result-card">
            <div class="result-head"><h3>${escapeHtml(item.title)}</h3><span class="score-pill">${item.score.toFixed(
              1
            )}</span></div>
            <div class="meta-row"><span class="mono">${escapeHtml(item.path)}</span></div>
            <div class="chips">${item.reasons
              .slice(0, 4)
              .map((reason) => `<span class="chip">${escapeHtml(reason)}</span>`)
              .join("")}</div>
            <div class="action-row"><a class="btn ghost" href="${inspectLink}">Inspect</a></div>
          </article>`;
        })
        .join("")}</div>`
    : '<div class="empty">No related docs for current path.</div>';

  const recentHtml = recent.length
    ? `<div class="recent-list">${recent
        .map((item) => {
          const inspectLink = linkWith(queryParams, {
            tab: "context",
            viewPath: item.path,
            viewAnchor: "top",
            relatedPath: item.path
          });
          return `<a class="recent-link" href="${inspectLink}"><strong>${escapeHtml(item.title)}</strong><div class="muted mono">${escapeHtml(
            item.path
          )}</div><div class="chips">${tagPills(item.tags)}</div></a>`;
        })
        .join("")}</div>`
    : '<div class="empty">No indexed documents.</div>';

  const rawLogRecords = readMcpActionRecords(Math.max(5000, logState.logLimit * 12));
  const logEntries = buildMcpRequestLogs(rawLogRecords, toLogFilterInput(logState));
  const logToolOptions = [...DISPLAYED_MCP_TOOLS].sort((a, b) => a.localeCompare(b));
  const logPrefixOptions = [...new Set(rawLogRecords.map((record) => record.prefix))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete("tab");
  const logsExportHref = exportParams.toString() ? `/logs/export?${exportParams.toString()}` : "/logs/export";
  const logsHtml = renderLogList(logEntries);

  const allowedTabs = new Set(["search", "context", "health", "logs"]);
  const requestedTab = getStringParam(req.query.tab, "search").toLowerCase();
  const activeTab = allowedTabs.has(requestedTab) ? requestedTab : "search";
  const tabClass = (name: string): string => (activeTab === name ? " active" : "");

  const body = `
    <section class="panel hero">
      <p class="eyebrow">KnowledgeVaultMCP</p>
      <h1>KnowledgeVaultMCP Testing Lab</h1>
      <p class="subtitle">Validate routing, chunk search, section reads, related docs, and index freshness from one screen.</p>
    </section>

    <section class="panel">
      <nav class="tab-nav" aria-label="Tool tabs">
        <a class="tab-link${tabClass("search")}" href="${linkWith(queryParams, { tab: "search" })}">Search Diagnostics</a>
        <a class="tab-link${tabClass("context")}" href="${linkWith(queryParams, { tab: "context" })}">Context Inspector</a>
        <a class="tab-link${tabClass("health")}" href="${linkWith(queryParams, { tab: "health" })}">Corpus Health</a>
        <a class="tab-link${tabClass("logs")}" href="${linkWith(queryParams, { tab: "logs" })}">Request Logs</a>
      </nav>
    </section>

    <section class="panel tab-panel${tabClass("search")}" id="search">
      <div class="panel-head">
        <h2>Search Diagnostics</h2>
        <p class="muted"><code>search_knowledge</code> with snippet and score visibility.</p>
      </div>
      <form method="GET" action="/">
        <input type="hidden" name="tab" value="search" />
        <div class="form-grid" style="grid-template-columns: 1.6fr 1fr 1fr 110px 130px auto;">
          <label class="field"><span>Query</span><input name="query" value="${escapeHtml(query)}" placeholder="plural fallback locale" /></label>
          <label class="field"><span>Path Prefix</span><input name="searchPathPrefix" value="${escapeHtml(searchPathPrefix)}" placeholder="localization/" /></label>
          <label class="field"><span>Tags</span><input name="searchTags" value="${escapeHtml(searchTagsInput)}" placeholder="ios,runbook" /></label>
          <label class="field"><span>Limit</span><input name="searchLimit" value="${escapeHtml(String(searchLimit))}" /></label>
          <label class="field"><span>Max Per Doc</span><input name="maxPerDocument" value="${escapeHtml(String(maxPerDocument))}" /></label>
          <label class="field"><span>Run</span><button type="submit">Run Search</button></label>
        </div>
      </form>
      <div class="form-to-result">
        ${searchResultHtml}
        ${renderJsonDebug(
          "search_knowledge",
          {
            query,
            limit: searchLimit,
            maxPerDocument,
            pathPrefix: searchPathPrefix || undefined,
            tags: searchTags
          },
          searchResults
        )}
      </div>
    </section>

    <section class="panel tab-panel${tabClass("context")}" id="context">
      <div class="panel-head">
        <h2>Context Inspector</h2>
        <p class="muted">Section-first reads and full markdown inspection.</p>
      </div>
      <form method="GET" action="/">
        <input type="hidden" name="tab" value="context" />
        <div class="form-grid" style="grid-template-columns: 2fr 1fr 110px 110px auto;">
          <label class="field"><span>Path</span><input name="viewPath" value="${escapeHtml(defaultViewPath)}" placeholder="knowledge/localization.md" /></label>
          <label class="field"><span>Anchor</span><input name="viewAnchor" value="${escapeHtml(defaultViewAnchor)}" placeholder="plural-rules" /></label>
          <label class="field"><span>Before</span><input name="contextBefore" value="${escapeHtml(String(contextBefore))}" /></label>
          <label class="field"><span>After</span><input name="contextAfter" value="${escapeHtml(String(contextAfter))}" /></label>
          <label class="field"><span>Read</span><button type="submit">Inspect</button></label>
        </div>
      </form>
      <div class="accordion-list form-to-result">
        <details class="accordion-item" open>
          <summary class="accordion-summary">read_section</summary>
          <div class="accordion-body">
            ${sectionHtml}
            ${renderJsonDebug(
              "read_section",
              {
                path: defaultViewPath || undefined,
                anchor: defaultViewAnchor || undefined,
                contextBefore,
                contextAfter
              },
              sectionView ?? { error: sectionError || "no section" }
            )}
          </div>
        </details>
        <details class="accordion-item">
          <summary class="accordion-summary">read_doc</summary>
          <div class="accordion-body">
            ${documentHtml}
            ${renderJsonDebug(
              "read_doc",
              {
                path: defaultViewPath || undefined
              },
              documentView ?? { error: documentError || "no document" }
            )}
          </div>
        </details>
      </div>
    </section>

    <section class="panel tab-panel${tabClass("health")}" id="health">
      <div class="panel-head">
        <h2>Corpus Health</h2>
        <p class="muted">Watcher confidence and related-doc exploration.</p>
      </div>
      <div class="status-grid">
        <article class="status-card">
          <p class="muted mini">Indexed docs</p>
          <p class="status-value">${String(docsCount)}</p>
        </article>
        <article class="status-card">
          <p class="muted mini">Recent entries</p>
          <p class="status-value">${String(recent.length)}</p>
        </article>
        <article class="status-card">
          <p class="muted mini">Selected file</p>
          <p class="status-value" style="font-size:14px;line-height:1.35">${
            defaultViewPath
              ? `<span class="badge ${fileExists ? "" : "warn"}">${fileExists ? "exists" : "missing"}</span>`
              : "none"
          }</p>
        </article>
      </div>

      <div class="split form-to-result">
        <div>
          <h3 style="margin-bottom:6px">Recent Changes</h3>
          ${recentHtml}
        </div>
        <div>
          <h3 style="margin-bottom:6px">Related Docs</h3>
          <form method="GET" action="/" style="margin-bottom:12px">
            <input type="hidden" name="tab" value="health" />
            <div class="form-grid" style="grid-template-columns: 2fr 110px auto;">
              <label class="field"><span>Path</span><input name="relatedPath" value="${escapeHtml(relatedPath)}" placeholder="knowledge/localization.md" /></label>
              <label class="field"><span>Limit</span><input name="relatedLimit" value="${escapeHtml(String(relatedLimit))}" /></label>
              <label class="field"><span>Run</span><button type="submit">List</button></label>
            </div>
          </form>
          ${relatedHtml}
        </div>
      </div>

      ${renderJsonDebug(
        "list_docs/list_recent_changes/list_related_docs",
        {
          list_docs: { pathPrefix: undefined },
          list_recent_changes: { limit: 8 },
          list_related_docs: { path: relatedPath || undefined, limit: relatedLimit, modes: ["links", "tags", "path"] }
        },
        {
          docs_count: docsCount,
          recent,
          related
        }
      )}
    </section>

    <section class="panel tab-panel${tabClass("logs")}" id="logs">
      <div class="panel-head">
        <h2>Request Logs</h2>
        <p class="muted">Chronological tool calls with request and response payloads (JSON).</p>
      </div>
      <form method="GET" action="/" style="margin-bottom:14px">
        <input type="hidden" name="tab" value="logs" />
        <div class="form-grid" style="grid-template-columns: 1.2fr 1fr 1fr 1fr;">
          <label class="field"><span>Tool</span><select name="logTool">${renderSelectOptions(
            logToolOptions,
            logState.logTool,
            "all tools"
          )}</select></label>
          <label class="field"><span>Prefix</span><select name="logPrefix">${renderSelectOptions(
            logPrefixOptions,
            logState.logPrefix,
            "all prefixes"
          )}</select></label>
          <label class="field"><span>From</span><input type="datetime-local" name="logFrom" value="${escapeHtml(logState.logFrom)}" /></label>
          <label class="field"><span>To</span><input type="datetime-local" name="logTo" value="${escapeHtml(logState.logTo)}" /></label>
        </div>
        <div class="form-grid" style="grid-template-columns: 1.6fr 150px 190px auto; margin-top:8px;">
          <label class="field"><span>Contains</span><input name="logContains" value="${escapeHtml(
            logState.logContains
          )}" placeholder="path, error, tag" /></label>
          <label class="field"><span>Visible Logs</span><input name="logLimit" value="${escapeHtml(
            String(logState.logLimit)
          )}" /></label>
          <label class="field"><span>Only Errors</span><span class="checkbox-field"><input type="checkbox" name="logOnlyErrors" value="1" ${
            logState.logOnlyErrors ? 'checked="checked"' : ""
          } /><span class="muted mini">show failures only</span></span></label>
          <label class="field"><span>Apply</span><span class="inline-actions"><button type="submit">Refresh</button><a class="btn ghost" href="${logsExportHref}">Export NDJSON</a></span></label>
        </div>
      </form>
      <p class="muted" style="margin-bottom:12px">${String(logEntries.length)} entries shown from MCP action log file.</p>
      ${logsHtml}
    </section>
  `;

  res.type("html").send(pageLayout("KnowledgeVaultMCP", body));
});

app.get("/logs/export", (req, res) => {
  const logState = parseLogQuery(req.query as Record<string, unknown>);
  const rawLogRecords = readMcpActionRecords(Math.max(5000, logState.logLimit * 12));
  const entries = buildMcpRequestLogs(rawLogRecords, toLogFilterInput(logState));
  const filename = `mcp-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  res.send(payload ? `${payload}\n` : "");
});

app.get("/doc", (req, res) => {
  const documentPath = getStringParam(req.query.path);
  const query = getStringParam(req.query.q);
  const anchor = getStringParam(req.query.anchor);

  const params = new URLSearchParams();
  params.set("tab", "context");
  if (documentPath) {
    params.set("viewPath", documentPath);
  }
  if (query) {
    params.set("query", query);
  }
  if (anchor) {
    params.set("viewAnchor", anchor);
  }

  const suffix = params.toString();
  res.redirect(suffix ? `/?${suffix}` : "/");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(WEB_PORT, () => {
  console.log(`[web] http://localhost:${WEB_PORT}`);
});

const shutdown = (): void => {
  db.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
