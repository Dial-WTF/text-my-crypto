import { describe, expect, it } from "vitest";
import { users } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";

describe("db", () => {
  it("migrates and enforces unique phone", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ id: "u1", phone: "+15550000001", handle: "alex" });
    await expect(db.insert(users).values({ id: "u2", phone: "+15550000001", handle: "sam" })).rejects.toThrow();
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
