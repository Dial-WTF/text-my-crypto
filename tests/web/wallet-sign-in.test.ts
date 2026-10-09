import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotDeps } from "@/lib/bot/types";
import type { Db } from "@/lib/db/client";
import { type User, users } from "@/lib/db/schema";
import { createUser } from "@/lib/identity";
import { issueWalletCode, SESSION_COOKIE, sessionUser } from "@/lib/web/sessions";
import { createTestDb } from "../helpers/db";
import { testDeps } from "../helpers/fakes";

const now = new Date("2026-10-09T12:00:00Z");
const state: { deps?: BotDeps; signedIn: User | null } = { signedIn: null };

vi.mock("@/lib/deps", () => ({ botDeps: () => state.deps }));
vi.mock("@/lib/web/current", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web/current")>()),
  currentUser: async () => state.signedIn,
}));

const { POST } = await import("@/app/api/wallet/sign-in/route");
const { default: HandleWalletPage } = await import("@/app/pay/[handle]/wallet/page");

let db: Db;
let alex: User;

beforeEach(async () => {
  db = await createTestDb();
  alex = await createUser(db, { phone: "+15550000401", handle: "alex", name: "Alex" }, now);
  state.deps = testDeps(db, { now: () => now });
  state.signedIn = null;
});

const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  POST(new Request("https://tmc.test/api/wallet/sign-in", { method: "POST", body: new URLSearchParams(fields), headers }));

const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

/** The dial_session value a response sets, or null. */
function sessionCookie(res: Response): string | null {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return c ? decodeURIComponent(c.slice(SESSION_COOKIE.length + 1).split(";")[0]!) : null;
}

describe("POST /api/wallet/sign-in", () => {
  it("a right code for the handle sets the session cookie and 303s to /wallet; the code is burned", async () => {
    const { code } = await issueWalletCode(db, alex.id, now);
    const res = await post({ handle: "alex", code });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wallet");
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const token = sessionCookie(res);
    expect((await sessionUser(db, token ?? undefined, now))?.id).toBe(alex.id);

    const again = await post({ handle: "alex", code });
    expect(again.headers.get("location")).toBe("/@alex/wallet?error=closed");
    expect(sessionCookie(again)).toBeNull();
  });

  it("takes the handle the way it appears in links: with an @ or capitals", async () => {
    const { code } = await issueWalletCode(db, alex.id, now);
    const res = await post({ handle: "@Alex", code });
    expect(res.headers.get("location")).toBe("/wallet");
    expect(sessionCookie(res)).not.toBeNull();
  });

  it("a wrong code goes back to the form with ?error=code and no cookie", async () => {
    const { code } = await issueWalletCode(db, alex.id, now);
    const res = await post({ handle: "alex", code: wrongFor(code) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/@alex/wallet?error=code");
    expect(sessionCookie(res)).toBeNull();
  });

  it("no open code goes back with ?error=closed: never issued, expired, or an unknown handle", async () => {
    expect((await post({ handle: "alex", code: "123456" })).headers.get("location")).toBe("/@alex/wallet?error=closed");
    const { code } = await issueWalletCode(db, alex.id, new Date(now.getTime() - 16 * 60_000));
    expect((await post({ handle: "alex", code })).headers.get("location")).toBe("/@alex/wallet?error=closed");
    expect((await post({ handle: "nobody", code: "123456" })).headers.get("location")).toBe("/@nobody/wallet?error=closed");
  });

  it("an unclaimed account's code never signs in", async () => {
    await db.insert(users).values({ id: "usr_unclaimed", phone: "+15550000402", handle: "pending" });
    const { code } = await issueWalletCode(db, "usr_unclaimed", now);
    const res = await post({ handle: "pending", code });
    expect(res.headers.get("location")).toBe("/@pending/wallet?error=closed");
    expect(sessionCookie(res)).toBeNull();
  });

  it("legacy token links: right code signs in, wrong code and closed links go back to the link", async () => {
    const { token, code } = await issueWalletCode(db, alex.id, now);
    const wrong = await post({ token, code: wrongFor(code) });
    expect(wrong.headers.get("location")).toBe(`/wallet/in/${token}?error=code`);
    const right = await post({ token, code });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/wallet");
    expect((await sessionUser(db, sessionCookie(right) ?? undefined, now))?.id).toBe(alex.id);
    expect((await post({ token, code })).headers.get("location")).toBe(`/wallet/in/${token}?error=closed`);
  });

  it("only ever redirects to a path on this site", async () => {
    const odd = await post({ token: "//evil.example/x?y", code: "123456" });
    expect(odd.headers.get("location")).toBe("/wallet/in/%2F%2Fevil.example%2Fx%3Fy?error=closed");
    for (const handle of ["", "//evil.example", "a/b", "%E0"]) {
      expect((await post({ handle, code: "123456" })).headers.get("location")).toBe("/wallet");
    }
    const notAForm = await POST(new Request("https://tmc.test/api/wallet/sign-in", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(notAForm.headers.get("location")).toBe("/wallet");
  });

  it("refuses a form posted from another site", async () => {
    const { code } = await issueWalletCode(db, alex.id, now);
    const res = await post({ handle: "alex", code }, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeNull();
    expect((await post({ handle: "alex", code }, { "sec-fetch-site": "same-origin" })).headers.get("location")).toBe("/wallet");
  });
});

describe("/@handle/wallet", () => {
  const open = (handle: string, error?: string) =>
    HandleWalletPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(error ? { error } : {}) });

  it("is a plain 404 for unknown and unclaimed handles", async () => {
    await db.insert(users).values({ id: "usr_unclaimed", phone: "+15550000402", handle: "pending" });
    for (const handle of ["nobody", "pending", "%E0"]) {
      await expect(open(handle)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    }
  });

  it("sends the owner, already signed in, straight to /wallet", async () => {
    state.signedIn = alex;
    await expect(open("alex")).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("shows the code form to anyone else", async () => {
    const other = await createUser(db, { phone: "+15550000403", handle: "sam" }, now);
    state.signedIn = other;
    await expect(open("alex", "code")).resolves.toBeTruthy();
    state.signedIn = null;
    await expect(open("@Alex")).resolves.toBeTruthy();
  });
});
