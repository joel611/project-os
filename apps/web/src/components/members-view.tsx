import { type Member, type Role, type SharedAccountsView } from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, describeError } from "@/api";
import { CHANNEL_META, PROVIDER_META } from "@/components/source";
import { Empty, QueryError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/model";
import { SLOW_MS } from "@/polling";
import {
  AssignCell,
  SharedAccountsLoading,
  SharedAccountsSection,
  useSharedAccounts,
} from "@/components/shared-accounts";
import { useNow } from "@/use-now";

const NOT_CONNECTED = <span className="text-muted-foreground">Not connected</span>;

const Identity = ({ Logo, label }: { Logo: typeof CHANNEL_META.discord.Icon; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <Logo className="size-3.5 shrink-0" />
    {label}
  </span>
);

const channelCell = (m: Member) => {
  if (!m.channel) return NOT_CONNECTED;
  const meta = CHANNEL_META[m.channel.type];
  return <Identity Logo={meta.Icon} label={m.channel.name ?? m.channel.id} />;
};

const githubCell = (m: Member) =>
  m.github ? (
    <Identity Logo={PROVIDER_META.github.Logo} label={m.github.login ?? "Linked"} />
  ) : (
    NOT_CONNECTED
  );

const dashboardCell = (m: Member, now: Date) =>
  m.dashboard ? (
    m.dashboard.lastSignInAt ? (
      `Signed in ${relativeTime(m.dashboard.lastSignInAt, now)}`
    ) : (
      "Has access"
    )
  ) : (
    <span className="text-muted-foreground">Never signed in</span>
  );

const Who = ({ m }: { m: Member }) => (
  <div className="flex min-w-0 flex-col">
    <span className="flex items-center gap-2 font-medium">
      <span className="truncate">{m.name}</span>
      {m.role === "admin" && <Badge variant="secondary">Admin</Badge>}
    </span>
    {m.email && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
  </div>
);

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", member: "Member" };

/**
 * An admin's role picker for a dashboard operator. Anyone else (a channel person with no
 * dashboard login of their own) is a member and has nothing to change.
 */
const RoleCell = ({ m }: { m: Member }) => {
  const qc = useQueryClient();
  const setRole = useMutation({
    mutationFn: (role: Role) => api.setMemberRole(m.key, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });
  if (!m.operator) return <span className="text-muted-foreground">{ROLE_LABEL[m.role]}</span>;
  return (
    <div className="flex flex-col gap-1">
      <Select
        items={(Object.keys(ROLE_LABEL) as Role[]).map((value) => ({
          value,
          label: ROLE_LABEL[value],
        }))}
        value={m.role}
        onValueChange={(role) => role && setRole.mutate(role as Role)}
        disabled={setRole.isPending}
      >
        <SelectTrigger aria-label={`Role of ${m.name}`} className="h-8 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ROLE_LABEL) as Role[]).map((value) => (
            <SelectItem key={value} value={value}>
              {ROLE_LABEL[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setRole.error && (
        <span className="text-xs text-destructive">
          {setRole.error instanceof ApiError && setRole.error.code === "LastAdmin"
            ? "Keep at least one admin."
            : describeError(setRole.error)}
        </span>
      )}
    </div>
  );
};

const NO_SHARED: SharedAccountsView = { accounts: [], assignments: [] };

const Row = ({ m, now, shared }: { m: Member; now: Date; shared: SharedAccountsView }) => (
  <TableRow>
    <TableCell className="max-w-64 py-3.5 pl-6">
      <Who m={m} />
    </TableCell>
    <TableCell className="py-3.5">{dashboardCell(m, now)}</TableCell>
    <TableCell className="py-3.5">
      <RoleCell m={m} />
    </TableCell>
    <TableCell className="py-3.5">{channelCell(m)}</TableCell>
    <TableCell className="py-3.5">{githubCell(m)}</TableCell>
    <TableCell className="py-3.5 pr-6">
      <AssignCell member={m} view={shared} />
    </TableCell>
  </TableRow>
);

const Card = ({ m, now, shared }: { m: Member; now: Date; shared: SharedAccountsView }) => (
  <li className="flex flex-col gap-3 rounded-xl border bg-card p-4">
    <Who m={m} />
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Dashboard</dt>
      <dd>{dashboardCell(m, now)}</dd>
      <dt className="text-muted-foreground">Role</dt>
      <dd>
        <RoleCell m={m} />
      </dd>
      <dt className="text-muted-foreground">Discord</dt>
      <dd>{channelCell(m)}</dd>
      <dt className="text-muted-foreground">GitHub</dt>
      <dd>{githubCell(m)}</dd>
      <dt className="text-muted-foreground">Shared</dt>
      <dd>
        <AssignCell member={m} view={shared} />
      </dd>
    </dl>
  </li>
);

export const MembersView = () => {
  const now = useNow();
  const members = useQuery({
    queryKey: ["members"],
    queryFn: api.members,
    refetchInterval: SLOW_MS,
  });
  const sharedQuery = useSharedAccounts();
  const shared = sharedQuery.data ?? NO_SHARED;
  const list = members.data ?? [];
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Members</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Each person's dashboard sign-in, Discord user and GitHub account. They are matched through
          the Google account a person links with /connect google, so the GitHub account can use any
          email.
        </p>
      </header>
      <SharedAccountsLoading query={sharedQuery} />
      {sharedQuery.data && <SharedAccountsSection view={sharedQuery.data} />}
      {members.error ? (
        <QueryError error={members.error} />
      ) : members.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.length === 0 ? (
        <Empty
          title="No members yet"
          hint="People appear after they sign in to the dashboard or run /connect in Discord."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3 sm:hidden">
            {list.map((m) => (
              <Card key={m.key} m={m} now={now} shared={shared} />
            ))}
          </ul>
          <div className="hidden rounded-xl border bg-card sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Person</TableHead>
                  <TableHead>Dashboard</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Discord</TableHead>
                  <TableHead>GitHub</TableHead>
                  <TableHead className="pr-6">Shared accounts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((m) => (
                  <Row key={m.key} m={m} now={now} shared={shared} />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
};
