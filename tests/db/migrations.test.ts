import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sql-js";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

const DIR = join(process.cwd(), "drizzle");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** A fresh database with the first `count` migrations applied whole, the way `wrangler d1 migrations apply` runs them. */
async function migrated(count = files.length) {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON;");
  for (const file of files.slice(0, count)) sqlite.exec(readFileSync(join(DIR, file), "utf8"));
  return drizzle(sqlite, { schema });
}

/** The statements drizzle-kit would run to make the database match src/lib/db/schema.ts. Empty means no drift. */
async function drift(db: Awaited<ReturnType<typeof migrated>>): Promise<string[]> {
  const { pushSQLiteSchema } = await import("drizzle-kit/api");
  // drizzle-kit draws a progress spinner straight to stdout; keep the test output clean.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    // pushSQLiteSchema is typed for drizzle-kit's own LibSQL handle; it only calls run/all/values on it.
    return (await pushSQLiteSchema(schema, db as unknown as Parameters<typeof pushSQLiteSchema>[1])).statementsToExecute;
  } finally {
    process.stdout.write = write;
  }
}

describe("drizzle migrations", () => {
  it("are numbered 0000, 0001, … with no gaps or duplicates", () => {
    expect(files.map((f) => f.slice(0, 4))).toEqual(files.map((_, i) => String(i).padStart(4, "0")));
  });

  it("are all in drizzle-kit's journal, in order", () => {
    const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(files);
  });

  it("applied in order to an empty database, produce exactly src/lib/db/schema.ts", async () => {
    expect(await drift(await migrated())).toEqual([]);
  }, 30_000);

  it("would catch a schema change with no migration (the check can see drift)", async () => {
    // Leave off the newest migration: the schema now has things the database doesn't.
    expect((await drift(await migrated(files.length - 1))).length).toBeGreaterThan(0);
  }, 30_000);
});
