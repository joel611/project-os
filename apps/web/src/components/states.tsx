import { AlertTriangle } from "lucide-react";
import { describeError } from "@/api";

export const QueryError = ({ error }: { error: Error }) => (
  <p className="flex items-start gap-2 px-2 text-sm text-destructive">
    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
    {describeError(error)}
  </p>
);

export const Empty = ({ title, hint }: { title: string; hint: React.ReactNode }) => (
  <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center">
    <p className="text-sm font-medium">{title}</p>
    <p className="text-sm text-muted-foreground">{hint}</p>
  </div>
);
