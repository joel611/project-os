import type { ActivityTicket, ChannelType } from "@project-os/contracts";
import {
  Brain,
  Cloud,
  Laptop,
  Mail,
  MessageCircle,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { ticketLabel, type Identity, type Module, type Packet } from "./feed.ts";
import type { Layout, MapNode } from "./iso.ts";
import type { Player, Trip } from "./player.ts";

/** What every map style draws from: the layout, the player, and per-node status. */
export interface SceneProps {
  readonly map: Layout;
  readonly player: Player;
  readonly workers: ReadonlyMap<string, WorkerView>;
  /** Tickets assigned and waiting for a Worker to pull them. */
  readonly waiting: ReadonlyArray<ActivityTicket>;
  readonly coordinatorLine: string;
}

export interface WorkerView {
  readonly line: string;
  readonly working: boolean;
  readonly offline: boolean;
}

export const CHANNEL_ICON: Readonly<Record<ChannelType, LucideIcon>> = {
  discord: MessageCircle,
  email: Mail,
  chat: MessagesSquare,
};

export const CHANNEL_COLOR: Readonly<Record<ChannelType, string>> = {
  discord: "var(--map-discord)",
  email: "var(--map-email)",
  chat: "var(--map-chat)",
};

/** Coordinator parts shown as tiles, in reading order. */
export const MODULES: ReadonlyArray<readonly [Module, string]> = [
  ["jev", "Jev"],
  ["tickets", "Tickets"],
  ["mcp", "MCP"],
  ["pi", "Pi reply"],
];

export const nodeIcon = (n: MapNode): LucideIcon => {
  if (n.kind === "coordinator") return Brain;
  if (n.kind === "worker") return n.workerType === "daytona_pi" ? Cloud : Laptop;
  return CHANNEL_ICON[n.channel ?? "chat"];
};

/** Edges with a packet on them right now, keyed `a|b` with ids sorted. */
export const hotEdges = (trips: ReadonlyArray<Trip>): Set<string> =>
  new Set(trips.map((t) => [t.from, t.to].sort().join("|")));

export const edgeKey = (a: string, b: string): string => [a, b].sort().join("|");

/** How far along its rail a trip is, 0..1. */
export const progressOf = (trip: Trip, now: number): number =>
  Math.min(1, (now - trip.start) / trip.duration);

const Avatar = ({ who, r = 13 }: { who: Identity; r?: number }) => {
  const Badge = CHANNEL_ICON[who.channel];
  return (
    <g>
      <title>{who.name}</title>
      <circle r={r} fill={who.color} stroke="var(--map-bg)" strokeWidth={2} />
      <text y={r * 0.27} textAnchor="middle" className="map-initials" fontSize={r * 0.77}>
        {who.initials}
      </text>
      <g transform={`translate(${r * 0.77} ${-r * 0.77})`}>
        <circle r={7} fill={CHANNEL_COLOR[who.channel]} stroke="var(--map-bg)" strokeWidth={1.5} />
        <Badge x={-4.25} y={-4.25} width={8.5} height={8.5} color="#fff" strokeWidth={2.5} />
      </g>
    </g>
  );
};

/** A packet's face: sender avatar, reply pill, ticket chip, or an MCP call. */
export const PacketBody = ({ packet }: { packet: Packet }) => {
  switch (packet.kind) {
    case "message":
      return <Avatar who={packet.who} />;
    case "reply":
      return (
        <g>
          <rect x={-38} y={-11} width={76} height={22} rx={11} className="map-reply" />
          {packet.who && (
            <g transform="translate(-26 0)">
              <circle r={8} fill={packet.who.color} stroke="#fff" strokeWidth={1.2} />
              <text y={2.6} textAnchor="middle" className="map-initials" fontSize={7}>
                {packet.who.initials}
              </text>
            </g>
          )}
          <text x={packet.who ? 6 : 0} y={4} textAnchor="middle" className="map-chip-text">
            reply
          </text>
        </g>
      );
    case "ticket":
      return (
        <g>
          <rect
            x={-31}
            y={-11}
            width={62}
            height={22}
            rx={6}
            className={`map-chip map-chip-${packet.tone}`}
          />
          <text y={4} textAnchor="middle" className="map-chip-text">
            {packet.tone === "done" ? "✓ " : packet.tone === "failed" ? "✕ " : ""}
            {ticketLabel(packet.ticketId)}
          </text>
        </g>
      );
    case "call":
      return (
        <g>
          <circle r={4.5} className="map-call" />
          <text y={-10} textAnchor="middle" className="map-call-label">
            {packet.label}
          </text>
        </g>
      );
  }
};

/** A ticket waiting at the Coordinator for a Worker to pull it. */
export const WaitingChip = ({ ticket, x, y }: { ticket: ActivityTicket; x: number; y: number }) => (
  <g transform={`translate(${x} ${y})`}>
    <title>{ticket.title}</title>
    <rect x={-28} y={-10} width={56} height={20} rx={5} className="map-chip map-chip-work" />
    <text y={4} textAnchor="middle" className="map-chip-text">
      {ticketLabel(ticket.id)}
    </text>
  </g>
);
