import type { ActivityTicket, TicketStatus } from "@project-os/contracts";
import { STATUS } from "@/model";
import { identityOf, ticketLabel, type Identity } from "./feed.ts";
import { workerName, type LogLine, type LogPart } from "./log.ts";

const TICKET_ROWS = 8;

const Avatar = ({ who }: { who: Identity }) => (
  <span className="map-av" style={{ background: who.color }} title={who.name}>
    {who.initials}
  </span>
);

/** The last few tickets, newest first, with the status the map is showing for each. */
export const TicketsCard = ({
  tickets,
  statusOf,
}: {
  tickets: ReadonlyArray<ActivityTicket>;
  statusOf: (t: ActivityTicket) => TicketStatus;
}) => {
  const rows = [...tickets]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, TICKET_ROWS);
  return (
    <section className="map-card">
      <h2>
        Tickets <small>status comes from the same events as the map</small>
      </h2>
      <div className="overflow-x-auto">
        <table className="map-table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>From</th>
              <th>Intent</th>
              <th>Status</th>
              <th>Worker</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted-foreground">
                  No tickets yet
                </td>
              </tr>
            ) : (
              rows.map((t) => {
                const who = t.origin ? identityOf(t.origin) : null;
                const status = statusOf(t);
                return (
                  <tr key={t.id}>
                    <td className="map-mono" title={t.title}>
                      {ticketLabel(t.id)}
                    </td>
                    <td>
                      {who ? (
                        <span className="inline-flex items-center">
                          <Avatar who={who} />
                          {who.name}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="map-mono">{t.intent ?? "—"}</td>
                    <td>
                      <span className={`map-pill st-${status}`}>{STATUS[status].label}</span>
                    </td>
                    <td className="map-mono">
                      {t.workerId || t.workerType ? workerName(t.workerId, t.workerType) : "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const TONE_COLOR: Record<LogLine["tone"], string> = {
  discord: "var(--map-discord)",
  email: "var(--map-email)",
  chat: "var(--map-chat)",
  coordinator: "var(--map-accent)",
  worker: "var(--map-busy)",
  ok: "var(--map-done)",
  failed: "var(--map-failed)",
};

const Part = ({ part }: { part: LogPart }) =>
  typeof part === "string" ? (
    part
  ) : "code" in part ? (
    <code>{part.code}</code>
  ) : (
    <>
      <Avatar who={part.who} />
      <b>{part.who.name}</b>
    </>
  );

/** Everything the system did, newest on top, in the words of the artifact's log. */
export const EventLogCard = ({ lines }: { lines: ReadonlyArray<LogLine> }) => (
  <section className="map-card">
    <h2>
      Event log <small>live, newest on top</small>
    </h2>
    {lines.length === 0 ? (
      <p className="text-sm text-muted-foreground">Nothing in the last 15 minutes.</p>
    ) : (
      <ul className="map-log">
        {lines.map((l) => (
          <li key={l.id}>
            <time dateTime={l.at}>{new Date(l.at).toTimeString().slice(0, 8)}</time>
            <span className="dot" style={{ background: TONE_COLOR[l.tone] }} />
            <span>
              {l.parts.map((p, i) => (
                <Part key={i} part={p} />
              ))}
            </span>
          </li>
        ))}
      </ul>
    )}
  </section>
);
