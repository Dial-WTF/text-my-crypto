import { NextResponse } from "next/server";
import { botDeps } from "@/lib/deps";
import { formText } from "@/lib/form";
import { findUserByHandle, isClaimed } from "@/lib/identity";
import { SESSION_COOKIE_OPTIONS } from "@/lib/web/current";
import { handleFromParam } from "@/lib/web/pay-page";
import { createSession, type LoginRedeemed, redeemLoginLink, redeemWalletCode, SESSION_COOKIE } from "@/lib/web/sessions";

export const dynamic = "force-dynamic";

/** A 303 to a path on this site. Every Location here is a relative path built from a fixed prefix. */
function see(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path, "cache-control": "no-store" } });
}

const back = (form: string, r: Extract<LoginRedeemed, { ok: false }>) => `${form}?error=${r.reason === "bad_code" ? "code" : "closed"}`;

/**
 * The wallet sign-in form, posted as a plain HTML form: from /@handle/wallet (handle + code) or from a
 * /wallet/in/<token> link texted before that page existed (token + code). A right code burns it, starts a
 * session, sets the cookie on this response and sends the browser to /wallet with a full page load.
 *
 * A plain POST and a 303, not a server action: the session cookie rides on the same response the browser
 * follows, with nothing on the client in between.
 */
export async function POST(req: Request): Promise<Response> {
  // A form on another site can't sign this browser in to someone else's wallet (login CSRF).
  if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Sign in from Dial's own page.", { status: 403 });
  const form = await req.formData().catch(() => null);
  if (!form) return see("/wallet");
  const code = formText(form, "code");
  const deps = botDeps();
  const now = deps.now();

  const token = formText(form, "token");
  let page: string;
  let r: LoginRedeemed;
  if (token) {
    page = `/wallet/in/${encodeURIComponent(token)}`;
    r = await redeemLoginLink(deps.db, token, code, now);
  } else {
    const handle = handleFromParam(formText(form, "handle"));
    if (!handle) return see("/wallet");
    page = `/@${handle}/wallet`;
    const user = await findUserByHandle(deps.db, handle);
    r = user && isClaimed(user) ? await redeemWalletCode(deps.db, user.id, code, now) : { ok: false, reason: "closed" };
  }
  if (!r.ok) return see(back(page, r));

  const res = see("/wallet");
  res.cookies.set(SESSION_COOKIE, await createSession(deps.db, r.userId, "text", now), SESSION_COOKIE_OPTIONS);
  return res;
}
