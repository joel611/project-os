import { useQuery } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";
import { QueryError } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, isShownInline } from "@/model";
import { api } from "@/api";

/**
 * The files people sent on a ticket: pictures drawn in place (click to open full size), other
 * files as downloads. A link that can't be read any more says why instead of vanishing.
 */
export const TicketFiles = ({ ticketId }: { ticketId: string }) => {
  const files = useQuery({
    queryKey: ["ticket-attachments", ticketId],
    queryFn: () => api.ticketAttachments(ticketId),
    // Stored files get a one-hour link; refetching is cheap but asks Discord for the rest.
    staleTime: 10 * 60_000,
  });

  if (files.isPending) return <Skeleton className="h-32" />;
  if (files.isError) return <QueryError error={files.error} />;
  if (files.data.attachments.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Files</h3>
      <ul className="grid grid-cols-2 gap-3">
        {files.data.attachments.map((file) => (
          <li key={`${file.eventId}:${file.id}`} className="flex min-w-0 flex-col gap-1">
            {file.url !== null && isShownInline(file.contentType) ? (
              <a href={file.url} target="_blank" rel="noreferrer">
                <img
                  src={file.url}
                  alt={file.filename}
                  loading="lazy"
                  className="h-40 w-full rounded-md border bg-muted object-contain"
                />
              </a>
            ) : file.url !== null ? (
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border bg-muted text-muted-foreground hover:text-foreground"
              >
                <FileIcon className="size-8" />
                <span className="text-xs">Open</span>
              </a>
            ) : (
              <p className="flex h-40 items-center justify-center rounded-md border border-dashed px-3 text-center text-xs text-muted-foreground">
                {file.error ?? "This file can't be read any more."}
              </p>
            )}
            <p className="truncate text-xs" title={file.filename}>
              {file.filename}
              <span className="text-muted-foreground"> · {formatBytes(file.size)}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};
