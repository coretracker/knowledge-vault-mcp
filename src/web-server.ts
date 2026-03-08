import express from "express";
import { openDatabase } from "./db.js";
import { WEB_PORT } from "./config.js";
import { listRecentChanges, readDocumentFromDisk, searchKnowledge } from "./search.js";
import type { SearchOptions } from "./types.js";

const app = express();
const db = openDatabase();

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

function pageLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f8f9fb;
        --surface: #ffffff;
        --text: #17202a;
        --muted: #4f5d75;
        --accent: #0a66c2;
        --border: #d7dee8;
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        color: var(--text);
        background: radial-gradient(circle at top right, #e9f1ff, var(--bg));
      }
      .wrap {
        max-width: 1040px;
        margin: 0 auto;
        padding: 24px;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 16px;
      }
      h1, h2, h3 {
        margin-top: 0;
      }
      .grid {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: 16px;
      }
      .muted {
        color: var(--muted);
        font-size: 0.9rem;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr 120px;
        gap: 10px;
        margin-top: 10px;
      }
      button, .btn {
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: white;
        text-decoration: none;
        display: inline-block;
      }
      ul {
        padding-left: 18px;
      }
      li {
        margin-bottom: 10px;
      }
      code {
        background: #eff3f8;
        padding: 0 4px;
        border-radius: 4px;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: #0f1720;
        color: #e5eef8;
        padding: 16px;
        border-radius: 8px;
        font-size: 0.9rem;
      }
      mark {
        background: #ffe58f;
      }
      @media (max-width: 820px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">${body}</div>
  </body>
</html>`;
}

app.get("/", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const pathPrefix = typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : "";
  const tagsInput = typeof req.query.tags === "string" ? req.query.tags : "";
  const limitInput = typeof req.query.limit === "string" ? req.query.limit : "10";
  const limit = Number.parseInt(limitInput, 10);
  const tags = tagsInput
    ? tagsInput
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

  const searchOptions: SearchOptions = {
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 10
  };
  if (pathPrefix) {
    searchOptions.pathPrefix = pathPrefix;
  }
  if (tags) {
    searchOptions.tags = tags;
  }

  const results = q ? searchKnowledge(db, q, searchOptions) : [];

  const recent = listRecentChanges(db, 12);

  const resultItems = results.length
    ? `<ul>${results
        .map(
          (result) => `
          <li>
            <a href="/doc?path=${encodeURIComponent(result.path)}&q=${encodeURIComponent(q)}&anchor=${encodeURIComponent(result.anchor)}"><strong>${escapeHtml(result.title)}</strong></a>
            <div class="muted"><code>${escapeHtml(result.path)}</code> ${result.heading ? `| heading: ${escapeHtml(result.heading)}` : ""}</div>
            <div>${safeSnippet(result.snippet)}</div>
          </li>`
        )
        .join("")}</ul>`
    : q
      ? "<p class=\"muted\">No results.</p>"
      : "<p class=\"muted\">Enter a query to search knowledge chunks.</p>";

  const recentItems = recent.length
    ? `<ul>${recent
        .map(
          (item) => `<li><a href="/doc?path=${encodeURIComponent(item.path)}">${escapeHtml(item.title)}</a><div class=\"muted\"><code>${escapeHtml(item.path)}</code></div></li>`
        )
        .join("")}</ul>`
    : "<p class=\"muted\">No indexed documents yet.</p>";

  const body = `
    <h1>Knowledgebase Search</h1>
    <div class="grid">
      <section class="card">
        <form method="GET" action="/">
          <label for="q">Query</label>
          <input id="q" name="q" value="${escapeHtml(q)}" placeholder="incident runbook auth" />
          <div class="row">
            <div>
              <label for="pathPrefix">Path Prefix</label>
              <input id="pathPrefix" name="pathPrefix" value="${escapeHtml(pathPrefix)}" placeholder="runbooks/" />
            </div>
            <div>
              <label for="tags">Tags (comma)</label>
              <input id="tags" name="tags" value="${escapeHtml(tagsInput)}" placeholder="ops,incident" />
            </div>
            <div>
              <label for="limit">Limit</label>
              <input id="limit" name="limit" value="${escapeHtml(limitInput)}" />
            </div>
          </div>
          <div style="margin-top:10px"><button type="submit">Search</button></div>
        </form>
      </section>
      <aside class="card">
        <h3>Recent Changes</h3>
        ${recentItems}
      </aside>
    </div>
    <section class="card">
      <h2>Results</h2>
      ${resultItems}
    </section>
  `;

  res.type("html").send(pageLayout("Knowledgebase Search", body));
});

app.get("/doc", async (req, res) => {
  const documentPath = typeof req.query.path === "string" ? req.query.path : "";
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const anchor = typeof req.query.anchor === "string" ? req.query.anchor : "";

  if (!documentPath) {
    res.status(400).type("text/plain").send("Missing path query parameter.");
    return;
  }

  try {
    const document = await readDocumentFromDisk(documentPath);
    const matchingChunks = q
      ? searchKnowledge(db, q, { limit: 20, pathPrefix: document.path, maxPerDocument: 20 }).filter(
          (item) => item.path === document.path
        )
      : [];

    const matchInfo = matchingChunks.length
      ? `<div class="card"><h3>Matching Sections</h3><ul>${matchingChunks
          .map(
            (match) => `<li><strong>${escapeHtml(match.heading)}</strong><div>${safeSnippet(match.snippet)}</div></li>`
          )
          .join("")}</ul></div>`
      : q
        ? `<div class="card"><p class="muted">No matching sections for query <code>${escapeHtml(q)}</code>.</p></div>`
        : "";

    const anchorNote = anchor
      ? `<p class="muted">Matched anchor from result: <code>${escapeHtml(anchor)}</code></p>`
      : "";

    const body = `
      <p><a class="btn" href="/">Back to Search</a></p>
      <section class="card">
        <h1>${escapeHtml(document.title)}</h1>
        <p class="muted"><code>${escapeHtml(document.path)}</code></p>
        <p class="muted">Updated at: ${escapeHtml(document.updated_at)}</p>
        <p class="muted">Tags: ${document.tags.length ? document.tags.map((tag) => `<code>${escapeHtml(tag)}</code>`).join(" ") : "(none)"}</p>
        ${anchorNote}
      </section>
      ${matchInfo}
      <section class="card">
        <h3>Frontmatter</h3>
        <pre>${escapeHtml(JSON.stringify(document.frontmatter, null, 2))}</pre>
      </section>
      <section class="card">
        <h3>Markdown</h3>
        <pre>${escapeHtml(document.markdown)}</pre>
      </section>
    `;

    res.type("html").send(pageLayout(document.title, body));
  } catch (error) {
    res.status(404).type("text/plain").send((error as Error).message);
  }
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
