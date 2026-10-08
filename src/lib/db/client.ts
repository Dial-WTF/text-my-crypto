import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Db | undefined;

export function getDb(): Db {
  cached ??= drizzle(neon(env().DATABASE_URL), { schema }) as unknown as Db;
  return cached;
}
