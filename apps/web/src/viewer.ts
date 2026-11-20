import { useQuery } from "@tanstack/react-query";
import { type Action, allows, type Resource } from "@project-os/contracts";
import { api } from "./api.ts";
import { SLOW_MS } from "./polling.ts";

/** Where a member lands: the one page of the dashboard that is theirs. */
export const MY_TICKETS_PATH = "/mine";

/** Whether a member may be on this path: My tickets and its ticket pages only. */
export const memberMayVisit = (pathname: string): boolean =>
  pathname === MY_TICKETS_PATH || pathname.startsWith(`${MY_TICKETS_PATH}/`);

/** Whether the signed-in role may do `action` on `resource`; false until `GET /me` answers. */
export const useCan = <R extends Resource>(resource: R, action: Action<R>): boolean => {
  const viewer = useViewer().data;
  return viewer ? allows(viewer.permissions, resource, action) : false;
};

/** Who is signed in (`GET /me`): an Operator, or a member who sees only their own tickets. */
export const useViewer = () =>
  useQuery({ queryKey: ["me"], queryFn: api.me, refetchInterval: SLOW_MS });
