import { workerTicketUrl } from "@project-os/contracts";

export type FetchRunStop = (url: string, secret: string, signal: AbortSignal) => Promise<boolean>;

/** Poll independently of transcript traffic, including while a session is producing no output. */
export const watchRunStop = (options: {
  mcpUrl: string;
  ticketId: string;
  runId: string;
  secret: string;
  fetchStop: FetchRunStop;
  stop: () => void;
  intervalMs?: number;
}) => {
  const url = `${workerTicketUrl(options.mcpUrl, "runs", options.ticketId)}/${encodeURIComponent(options.runId)}/signal`;
  const controller = new AbortController();
  let pending = false;
  const close = () => {
    clearInterval(timer);
    controller.abort();
  };
  const timer = setInterval(async () => {
    if (pending || controller.signal.aborted) return;
    pending = true;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
      if ((await options.fetchStop(url, options.secret, signal)) && !signal.aborted) {
        close();
        options.stop();
      }
    } catch {
      // A network failure is not a stop signal. Try again on the next tick.
    } finally {
      pending = false;
    }
  }, options.intervalMs ?? 2_000);
  return close;
};
