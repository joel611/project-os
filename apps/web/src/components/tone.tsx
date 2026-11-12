import type { TicketStatus } from "@project-os/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS, type Tone } from "@/model";

const TONE: Readonly<Record<Tone, { readonly badge: string; readonly dot: string }>> = {
  neutral: { badge: "bg-tone-neutral-bg text-tone-neutral", dot: "bg-tone-neutral-dot" },
  info: { badge: "bg-tone-info-bg text-tone-info", dot: "bg-tone-info-dot" },
  progress: { badge: "bg-tone-progress-bg text-tone-progress", dot: "bg-tone-progress-dot" },
  warn: { badge: "bg-tone-warn-bg text-tone-warn", dot: "bg-tone-warn-dot" },
  success: { badge: "bg-tone-success-bg text-tone-success", dot: "bg-tone-success-dot" },
  danger: { badge: "bg-tone-danger-bg text-tone-danger", dot: "bg-tone-danger-dot" },
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
    <Badge className={cn("h-6 gap-1.5 border-0 px-2.5 font-medium", TONE[meta.tone].badge)}>
      <ToneDot tone={meta.tone} pulse={status === "in_progress"} />
      {meta.label}
    </Badge>
  );
};
