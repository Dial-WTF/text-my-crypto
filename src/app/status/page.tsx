import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { overall, STATE_WORDS, type ServiceState, type StatusRow } from "@/lib/public-status";
import { Desk } from "@/ui/patterns/Desk/Desk";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Stamp, type StampTone } from "@/ui/primitives/Stamp/Stamp";
import { Colophon } from "../colophon";
import { statusBoard } from "./board";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  description: "Whether the Dial operator's database, texting and every chain it settles on are up right now.",
  alternates: { canonical: "/status" },
};

const TONE: Record<ServiceState, StampTone> = { ok: "done", slow: "waiting", down: "bad" };

function Rows({ rows }: { rows: StatusRow[] }) {
  return rows.map((r) => (
    <ReceiptLine key={r.name} label={r.name}>
      <Stamp label={STATE_WORDS[r.state].label} tone={TONE[r.state]} />
    </ReceiptLine>
  ));
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 5 ? "just now" : `${s} seconds ago`;
};

export default async function StatusPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { value: rows, ageMs } = await statusBoard();
  const state = overall(rows);
  const services = rows.filter((r) => r.kind === "service");
  const networks = rows.filter((r) => r.kind === "network");

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Desk heading="Status" lede={STATE_WORDS[state].summary}>
        <Receipt title="Dial operator · status">
          <Stack gap="sm">
            <ReceiptLine label="Overall" total>
              <Stamp label={STATE_WORDS[state].label} tone={TONE[state]} />
            </ReceiptLine>
            {services.length ? (
              <>
                <ReceiptRule />
                <Fine caps>Services</Fine>
                <Rows rows={services} />
              </>
            ) : null}
            {networks.length ? (
              <>
                <ReceiptRule />
                <Fine caps>Networks</Fine>
                <Rows rows={networks} />
              </>
            ) : null}
            {rows.length === 0 ? <Fine>The checks couldn&apos;t run. Try again in a minute.</Fine> : null}
            <ReceiptRule />
            <Fine>
              Checked {ago(ageMs)}. These are read-only checks (the database answers, texting is signed in,
              each chain returns a balance) and run at most once a minute.
            </Fine>
          </Stack>
        </Receipt>
      </Desk>
    </SiteShell>
  );
}
