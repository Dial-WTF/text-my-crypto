import { ACTIONS_JSON, actionHeaders } from "@/lib/actions/spec";

/** Tells Blink clients which pages here are Solana Actions: every pay link (/@handle). */
export function GET(): Response {
  return Response.json(ACTIONS_JSON, { headers: actionHeaders(null) });
}

export function OPTIONS(): Response {
  return new Response(null, { headers: actionHeaders(null) });
}
