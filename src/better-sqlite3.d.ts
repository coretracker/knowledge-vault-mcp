declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(params?: unknown): RunResult;
    get(params?: unknown): unknown;
    all(params?: unknown): unknown[];
  }

  interface Database {
    pragma(source: string): unknown;
    exec(sql: string): this;
    prepare(sql: string): Statement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: unknown): Database;
    prototype: Database;
  }

  const Database: DatabaseConstructor;

  namespace Database {
    export type Database = import("better-sqlite3").Database;
  }

  export = Database;
}
