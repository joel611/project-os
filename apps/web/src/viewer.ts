import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { SLOW_MS } from "./polling.ts";

/** Where a member lands: the one page of the dashboard that is theirs. */
export const MY_TICKETS_PATH = "/mine";

/** Whether a member may be on this path: My tickets and its ticket sheets only. */
export const memberMayVisit = (pathname: string): boolean =>
  pathname === MY_TICKETS_PATH || pathname.startsWith(`${MY_TICKETS_PATH}/`);

/** Who is signed in (`GET /me`): an Operator, or a member who sees only their own tickets. */
export const useViewer = () =>
  useQuery({ queryKey: ["me"], queryFn: api.me, refetchInterval: SLOW_MS });
