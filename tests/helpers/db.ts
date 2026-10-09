import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sql-js";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

let SQL: SqlJsStatic | undefined;

/** In-memory SQLite with the real migrations applied. Same SQL dialect as D1. */
export async function createTestDb(): Promise<Db> {
  return drizzle(await createSqlite(), { schema }) as unknown as Db;
}

/** The raw sql.js database under createTestDb, for code that talks to D1 without drizzle. */
export async function createSqlite(): Promise<Database> {
  SQL ??= await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON;");
  const dir = join(process.cwd(), "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.run(stmt);
    }
  }
  return sqlite;
}
