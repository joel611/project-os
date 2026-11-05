import type { TicketStatus } from "@project-os/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS, type Tone } from "@/model";

const TONE: Readonly<Record<Tone, { readonly badge: string; readonly dot: string }>> = {
  neutral: { badge: "border-border text-muted-foreground", dot: "bg-muted-foreground/50" },
  info: { badge: "border-sky-500/30 bg-sky-500/10 text-sky-700", dot: "bg-sky-500" },
  progress: {
    badge: "border-violet-500/30 bg-violet-500/10 text-violet-700",
    dot: "bg-violet-500",
  },
  warn: { badge: "border-amber-500/30 bg-amber-500/10 text-amber-700", dot: "bg-amber-500" },
  success: {
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
    dot: "bg-emerald-500",
  },
  danger: { badge: "border-red-500/30 bg-red-500/10 text-red-700", dot: "bg-red-500" },
};

export const ToneDot = ({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) => (
  <span className="relative inline-flex size-2 shrink-0">
    {pulse && (
      <span
        className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE[tone].dot)}
      />
    )}
    <span className={cn("relative inline-flex size-2 rounded-full", TONE[tone].dot)} />
  </span>
);

export const StatusBadge = ({ status }: { status: TicketStatus }) => {
  const meta = STATUS[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", TONE[meta.tone].badge)}>
      <ToneDot tone={meta.tone} pulse={status === "in_progress"} />
      {meta.label}
    </Badge>
  );
};
