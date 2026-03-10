import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import type { ParsedChunk, ParsedLink } from "./types.js";

export type SqliteDatabase = Database.Database;

interface UpsertDocumentInput {
  path: string;
  title: string;
  tags: string[];
  updatedAt: string;
  mtimeMs: number;
  chunks: ParsedChunk[];
  links: ParsedLink[];
}

interface DocumentPathRow {
  path: string;
}

function initSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      tags_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT NOT NULL,
      anchor TEXT NOT NULL,
      body TEXT NOT NULL,
      title TEXT NOT NULL,
      tags TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);

    CREATE TABLE IF NOT EXISTS document_links (
      id INTEGER PRIMARY KEY,
      source_document_id INTEGER NOT NULL,
      target_path TEXT NOT NULL,
      target_anchor TEXT NOT NULL DEFAULT '',
      raw_target TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE(source_document_id, target_path, target_anchor)
    );

    CREATE INDEX IF NOT EXISTS idx_document_links_source ON document_links(source_document_id);
    CREATE INDEX IF NOT EXISTS idx_document_links_target ON document_links(target_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      title,
      tags,
      heading,
      body,
      content='chunks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, tags, heading, body)
      VALUES (new.id, new.title, new.tags, new.heading, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, tags, heading, body)
      VALUES ('delete', old.id, old.title, old.tags, old.heading, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, tags, heading, body)
      VALUES ('delete', old.id, old.title, old.tags, old.heading, old.body);
      INSERT INTO chunks_fts(rowid, title, tags, heading, body)
      VALUES (new.id, new.title, new.tags, new.heading, new.body);
    END;
  `);
}

export function openDatabase(dbPath = DB_PATH): SqliteDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  initSchema(db);
  return db;
}

export function listAllDocumentPaths(db: SqliteDatabase): string[] {
  const rows = db.prepare("SELECT path FROM documents").all() as DocumentPathRow[];
  return rows.map((row) => row.path);
}

export function removeDocumentByPath(db: SqliteDatabase, relativePath: string): number {
  const result = db.prepare("DELETE FROM documents WHERE path = ?").run(relativePath);
  return result.changes;
}

export function upsertDocumentWithChunks(db: SqliteDatabase, input: UpsertDocumentInput): { chunkCount: number } {
  const insertOrUpdateDocument = db.prepare(`
    INSERT INTO documents (path, title, tags_json, tags_text, updated_at, mtime_ms, indexed_at)
    VALUES (@path, @title, @tags_json, @tags_text, @updated_at, @mtime_ms, CURRENT_TIMESTAMP)
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      tags_json = excluded.tags_json,
      tags_text = excluded.tags_text,
      updated_at = excluded.updated_at,
      mtime_ms = excluded.mtime_ms,
      indexed_at = CURRENT_TIMESTAMP
  `);

  const selectDocumentId = db.prepare("SELECT id FROM documents WHERE path = ?");
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE document_id = ?");
  const deleteLinks = db.prepare("DELETE FROM document_links WHERE source_document_id = ?");
  const insertChunk = db.prepare(`
    INSERT INTO chunks (document_id, chunk_index, heading, anchor, body, title, tags, updated_at)
    VALUES (@document_id, @chunk_index, @heading, @anchor, @body, @title, @tags, @updated_at)
  `);
  const insertLink = db.prepare(`
    INSERT INTO document_links (source_document_id, target_path, target_anchor, raw_target)
    VALUES (@source_document_id, @target_path, @target_anchor, @raw_target)
  `);

  const tagsJson = JSON.stringify(input.tags);
  const tagsText = input.tags.join(",");

  const transaction = db.transaction(() => {
    insertOrUpdateDocument.run({
      path: input.path,
      title: input.title,
      tags_json: tagsJson,
      tags_text: tagsText,
      updated_at: input.updatedAt,
      mtime_ms: input.mtimeMs
    });

    const row = selectDocumentId.get(input.path) as { id: number } | undefined;
    if (!row) {
      throw new Error(`Document id lookup failed for ${input.path}`);
    }

    deleteChunks.run(row.id);
    deleteLinks.run(row.id);

    for (const chunk of input.chunks) {
      insertChunk.run({
        document_id: row.id,
        chunk_index: chunk.chunkIndex,
        heading: chunk.heading,
        anchor: chunk.anchor,
        body: chunk.body,
        title: input.title,
        tags: tagsText,
        updated_at: input.updatedAt
      });
    }

    for (const link of input.links) {
      insertLink.run({
        source_document_id: row.id,
        target_path: link.targetPath,
        target_anchor: link.targetAnchor ?? "",
        raw_target: link.rawTarget
      });
    }

    return input.chunks.length;
  });

  const chunkCount = transaction();
  return { chunkCount };
}
