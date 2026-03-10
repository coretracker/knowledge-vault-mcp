# KnowledgeVaultMCP

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-111111)
![SQLite FTS5](https://img.shields.io/badge/search-SQLite%20FTS5-003B57)

Local-first Markdown knowledge base with SQLite FTS5 indexing, MCP tools, and a minimal web UI.

KnowledgeVaultMCP indexes `knowledge/**/*.md`, keeps the index fresh with a filesystem watcher, and exposes retrieval tools over MCP (HTTP or stdio).

## Who This Is For

- Developers building agents that need fast, local, inspectable knowledge retrieval.
- Teams who prefer Markdown files on disk over hosted knowledge platforms.
- Anyone who wants predictable retrieval behavior without external vector services.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Run Modes and Commands](#run-modes-and-commands)
- [Configuration](#configuration)
- [MCP Client Setup](#mcp-client-setup)
- [Tool Call Flow](#tool-call-flow)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Roadmap and Scope](#roadmap-and-scope)
- [License](#license)

## Features

- Recursive Markdown indexing from `knowledge/`.
- YAML frontmatter support (`title`, `tags`, plus extra metadata).
- Section-level chunking by heading for targeted retrieval.
- SQLite-backed schema (`documents`, `chunks`, `document_links`, `chunks_fts`).
- FTS5 search with `bm25` ranking and snippets.
- Incremental watch mode for add/change/delete events.
- MCP read tools for search, document reads, and section reads.
- Optional write tool (`create_note`) with guardrails and audit logging.
- Local web UI for search validation and MCP request/response inspection.
- Canonical reads always come from disk, not cached DB content.

## Architecture

```text
knowledge/*.md
   |
   | parse + chunk + link extract
   v
SQLite (documents, chunks, links, FTS5)
   |                      |
   |                      +--> Web UI (search + inspect)
   |
   +--> MCP tools (HTTP / stdio)
```

Core behavior:

- `npm run index` performs a full rebuild/update of indexed docs.
- `npm run watch` does an initial full index, then applies incremental updates.
- Search reads from SQLite FTS5; document/section reads return canonical Markdown from disk.

## Prerequisites

- Node.js `>=20`
- npm

## Installation

```bash
git clone <your-repo-url>
cd knowledgevaultmcp
npm install
```

## Quick Start

```bash
npm run dev
```

`npm run dev` starts:

- Watcher/indexer
- MCP HTTP server at `http://127.0.0.1:3000/mcp`
- Web UI at `http://localhost:3030`

Put Markdown files in [`knowledge/`](./knowledge/README.md), then run queries from your MCP client or the web UI.

## Run Modes and Commands

```bash
npm run index         # one-shot full reindex
npm run watch         # initial full index, then watch for changes
npm run server        # MCP server over HTTP (127.0.0.1:3000/mcp)
npm run server:http   # alias of server
npm run server:stdio  # MCP server over stdio transport
npm run web           # web UI (localhost:3030)
npm run dev           # watch + MCP HTTP + web
npm run check         # TypeScript type-check
```

## Configuration

Environment variables from `src/config.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `KNOWLEDGE_DIR` | `./knowledge` | Markdown source directory |
| `DATA_DIR` | `./data` | Runtime data directory |
| `DB_PATH` | `./data/knowledge.db` | SQLite database path |
| `WEB_PORT` | `3030` | Web UI port |
| `MCP_HTTP_HOST` | `127.0.0.1` | MCP HTTP bind host |
| `MCP_HTTP_PORT` | `3000` | MCP HTTP bind port |
| `MCP_API_KEY` | unset | Optional API key for MCP HTTP requests |
| `MCP_ACTION_LOG_PATH` | `./data/mcp-actions.jsonl` | MCP action log file |
| `MCP_WRITE_AUDIT_LOG_PATH` | `./data/mcp-write-audit.jsonl` | Write-tool audit log file |
| `MCP_ENABLE_WRITE_TOOLS` | `1` (`!= "0"`) | Enables/disables `create_note` |

Watcher tuning (from `src/watcher.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `WATCH_USE_POLLING` | `0` | Enables polling mode when set to `1` |
| `WATCH_POLL_INTERVAL` | `300` | Poll interval in milliseconds |

## MCP Client Setup

### HTTP transport

Start server:

```bash
npm run server
```

Optional API key:

```bash
MCP_API_KEY=your-secret npm run server
```

Client config example:

```json
{
  "mcpServers": {
    "knowledge-vault-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "API_KEY": "your-secret"
      }
    }
  }
}
```

Accepted API key headers are `API_KEY`, `X-API-Key`, or `API-Key`.

### Stdio transport

```json
{
  "command": "npm",
  "args": ["run", "server:stdio"],
  "cwd": "/absolute/path/to/knowledgevaultmcp"
}
```

## Tool Call Flow

Recommended retrieval sequence for agent prompts:

1. `search_knowledge(query, limit=8, maxPerDocument=2)`
2. `read_section(path, anchor, contextBefore=1, contextAfter=1)` for top hits
3. `list_related_docs(path, limit=5)` if coverage is still incomplete
4. `read_doc(path)` only when full-file context is required

Available tools:

- `search_knowledge`
- `read_doc`
- `read_section`
- `list_docs`
- `list_related_docs`
- `list_recent_changes`
- `create_note` (only when `MCP_ENABLE_WRITE_TOOLS` is enabled)

## Operations

### Indexing lifecycle

1. Scan Markdown files under `KNOWLEDGE_DIR`
2. Parse frontmatter + body
3. Build section chunks and internal links
4. Upsert `documents` row and replace related `chunks`/`document_links`
5. Keep `chunks_fts` synchronized via SQLite triggers
6. Remove stale DB rows for deleted files during full index

### Watch behavior

- `add` and `change` events reindex a single file.
- `unlink` removes the corresponding document row.
- Updates are serialized through a queue to avoid concurrent write races.

### Storage and logs

- Primary DB: `data/knowledge.db` (unless overridden by `DB_PATH`)
- MCP action log: `data/mcp-actions.jsonl`
- Write audit log: `data/mcp-write-audit.jsonl`

## Troubleshooting

- No search results:
  Run `npm run index` and confirm Markdown files exist under `knowledge/`.
- Port already in use:
  Set `WEB_PORT` or `MCP_HTTP_PORT` before startup.
- Empty or corrupted local index:
  Stop processes, delete `data/knowledge.db`, then re-run `npm run index`.
- Missing updates in watch mode:
  Enable polling (`WATCH_USE_POLLING=1`) and tune `WATCH_POLL_INTERVAL`.
- `create_note` not available:
  Check `MCP_ENABLE_WRITE_TOOLS` is not `0`.
- HTTP calls return `401`:
  Ensure the client sends the same `MCP_API_KEY` value in an accepted header.

## Contributing

1. Create a branch from `main`.
2. Run `npm run check` before opening a PR.
3. Include reproducible steps for behavior changes.
4. Keep docs aligned when adding tools, env vars, or commands.

## Roadmap and Scope

Current intentional scope:

- Local-first Markdown + SQLite FTS retrieval
- MCP read tools plus optional guarded note creation
- Minimal web UI for retrieval and request-log inspection

Out of scope for now:

- Embeddings/vector databases
- External search services
- MCP edit/delete operations
- Hosted auth, cloud deployment, or Docker requirements

## License

No license file is currently defined in this repository.
