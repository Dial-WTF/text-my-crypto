import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { overall, STATE_WORDS, STATUS_TTL_MS, type ServiceState, type StatusRow } from "@/lib/public-status";
import type { Incident } from "@/lib/status-board";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Stamp, type StampTone } from "@/ui/primitives/Stamp/Stamp";
import { Colophon } from "../colophon";
import { statusBoard } from "./board";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Whether the Dial operator is answering texts, and whether its database, language model, escrow program and every chain it settles on are up right now.",
  alternates: { canonical: "/status" },
};

const TONE: Record<ServiceState, StampTone> = { ok: "done", slow: "waiting", down: "bad" };

function Rows({ rows }: { rows: StatusRow[] }) {
  return rows.map((r) => (
    <ReceiptLine key={r.name} label={r.name}>
      {r.link ? <Mono value={r.link.address} href={r.link.href} /> : r.value}
      {r.state ? (
        <>
          {r.link || r.value ? " " : null}
          <Stamp label={STATE_WORDS[r.state].label} tone={TONE[r.state]} />
        </>
      ) : null}
    </ReceiptLine>
  ));
}

function Group({ title, rows }: { title: string; rows: StatusRow[] }) {
  if (!rows.length) return null;
  return (
    <>
      <ReceiptRule />
      <Fine caps>{title}</Fine>
      <Rows rows={rows} />
    </>
  );
}

function Incidents({ incidents }: { incidents: Incident[] | null }) {
  if (incidents === null) return <Fine>Incidents couldn&apos;t be read just now.</Fine>;
  if (!incidents.length) return <Fine>No incidents in the last 24 hours.</Fine>;
  return incidents.map((i, n) => (
    <Stack key={n} gap="2xs">
      <ReceiptLine label={i.label}>
        <Stamp label={i.open ? "open" : "fixed"} tone={i.open ? "bad" : "done"} />
      </ReceiptLine>
      <Fine>
        Started {i.started}
        {i.resolved ? `, fixed ${i.resolved}` : ", not fixed yet"}.
      </Fine>
    </Stack>
  ));
}

const updated = (ageMs: number) => (ageMs < 10_000 ? "just now" : "under a minute ago");

export default async function StatusPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { value: board, ageMs } = await statusBoard();
  const { rows, problems, incidents } = board;
  const state = overall(rows);
  const of = (kind: StatusRow["kind"]) => rows.filter((r) => r.kind === kind);

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      {/* Reloads with the board's cache, and works with JavaScript off. React puts it in the head. */}
      <meta httpEquiv="refresh" content={String(STATUS_TTL_MS / 1000)} />
      <Desk heading="Status" lede={STATE_WORDS[state].summary}>
        <Receipt title="Dial operator · status">
          <Stack gap="sm">
            <ReceiptLine label="Overall" total>
              <Stamp label={STATE_WORDS[state].label} tone={TONE[state]} />
            </ReceiptLine>
            {rows.length === 0 ? <Fine>The checks couldn&apos;t run. Try again in a minute.</Fine> : null}
            <Group title="Texting" rows={of("texting")} />
            <Group title="Services" rows={of("service")} />
            <Group title="Networks" rows={of("network")} />
            <Group title="Watchdog" rows={of("watchdog")} />
            {problems.map((p) => (
              <Fine key={p}>· {p}</Fine>
            ))}
            {rows.length ? (
              <>
                <ReceiptRule />
                <Fine caps>Incidents, last 24 hours</Fine>
                <Incidents incidents={incidents} />
              </>
            ) : null}
            <ReceiptRule />
            <Fine>Last updated {updated(ageMs)}. This page refreshes itself every minute.</Fine>
            <Fine>
              The checks are read-only: the database answers, texting is signed in, the language model reads a
              sample text, the escrow program is on chain and each chain returns a balance. They run at most once a
              minute (the language model every five), and every age here is rounded.
            </Fine>
          </Stack>
        </Receipt>
      </Desk>
    </SiteShell>
  );
}
