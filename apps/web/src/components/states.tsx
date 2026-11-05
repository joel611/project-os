import { AlertTriangle } from "lucide-react";
import { describeError } from "@/api";

export const QueryError = ({ error }: { error: Error }) => (
  <p className="flex items-start gap-2 px-2 text-sm text-red-700">
    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
    {describeError(error)}
  </p>
);

export const Empty = ({ title, hint }: { title: string; hint: React.ReactNode }) => (
  <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-6 py-10 text-center">
    <p className="text-sm font-medium">{title}</p>
    <p className="text-sm text-muted-foreground">{hint}</p>
  </div>
);
