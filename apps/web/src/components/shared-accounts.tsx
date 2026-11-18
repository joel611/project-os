import type {
  ConnectionProvider,
  Member,
  SharedAccount,
  SharedAccountsView,
} from "@project-os/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { api, describeError } from "@/api";
import { PROVIDER_META } from "@/components/source";
import { Empty, QueryError } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { SLOW_MS } from "@/polling";

/** The connectors a shared account can stand in for. */
export const CONNECTORS: ReadonlyArray<{
  readonly id: ConnectionProvider;
  readonly label: string;
  readonly Logo: (typeof PROVIDER_META)["github"]["Logo"];
}> = [
  { id: "github", label: "GitHub", Logo: PROVIDER_META.github.Logo },
  { id: "google", label: "Google Drive", Logo: PROVIDER_META.google_drive.Logo },
  { id: "clickup", label: "ClickUp", Logo: PROVIDER_META.clickup.Logo },
];

const connector = (id: ConnectionProvider) => CONNECTORS.find((c) => c.id === id)!;

export const useSharedAccounts = () =>
  useQuery({
    queryKey: ["shared-accounts"],
    queryFn: api.sharedAccounts,
    refetchInterval: SLOW_MS,
  });

/** Hands the browser to the Coordinator's connect page: the same OAuth flow as /connect. */
const openConnect = (url: string) => window.location.assign(url);

const Problem = ({ error }: { error: Error | null }) =>
  error && (
    <p role="alert" className="text-sm text-destructive">
      {describeError(error)}
    </p>
  );

const AddAccount = () => {
  const [provider, setProvider] = useState<ConnectionProvider>("github");
  const [label, setLabel] = useState("");
  const add = useMutation({
    mutationFn: () => api.addSharedAccount({ provider, label: label.trim() }),
    onSuccess: (created) => openConnect(created.connectUrl),
  });
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    if (label.trim()) add.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          items={CONNECTORS.map((c) => ({ value: c.id, label: c.label }))}
          value={provider}
          onValueChange={(id) => id && setProvider(id as ConnectionProvider)}
        >
          <SelectTrigger aria-label="Connector" className="h-9 min-w-36 sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {CONNECTORS.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Name"
          placeholder="Name, e.g. Ops bot"
          maxLength={60}
          autoComplete="off"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="sm:max-w-64"
        />
        <Button type="submit" disabled={!label.trim() || add.isPending}>
          <Plus /> {add.isPending ? "Opening…" : "Connect account"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Signs in with the provider, so use the account the team should share (a bot user is best).
        It can't also be someone's personal link.
      </p>
      <Problem error={add.error} />
    </form>
  );
};

const RemoveAccount = ({ account, onClose }: { account: SharedAccount; onClose: () => void }) => {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeSharedAccount(account.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["shared-accounts"] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {account.label}?</DialogTitle>
          <DialogDescription>
            This deletes the stored {connector(account.provider).label} tokens and unassigns it from
            everyone. People without a link of their own will be asked to run /connect again.
          </DialogDescription>
        </DialogHeader>
        <Problem error={remove.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Removing…" : "Remove account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const AccountRow = ({ account, people }: { account: SharedAccount; people: number }) => {
  const [removing, setRemoving] = useState(false);
  const { Logo, label } = connector(account.provider);
  const reconnect = useMutation({
    mutationFn: () => api.reconnectSharedAccount(account.id),
    onSuccess: (link) => openConnect(link.connectUrl),
  });
  return (
    <li className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Logo className="size-5 shrink-0" />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2 font-medium">
            <span className="truncate">{account.label}</span>
            <Badge variant={account.connected ? "secondary" : "outline"}>
              {account.connected ? "Connected" : "Not connected"}
            </Badge>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {label}
            {account.identity ? ` · ${account.identity}` : ""} ·{" "}
            {people === 1 ? "1 person" : `${people} people`}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={reconnect.isPending}
          onClick={() => reconnect.mutate()}
        >
          <RefreshCw /> {account.connected ? "Reconnect" : "Finish connecting"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${account.label}`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 />
        </Button>
      </div>
      {reconnect.error && <Problem error={reconnect.error} />}
      {removing && <RemoveAccount account={account} onClose={() => setRemoving(false)} />}
    </li>
  );
};

/** Shared accounts: team logins an admin links once and assigns to people with none of their own. */
export const SharedAccountsSection = ({ view }: { view: SharedAccountsView }) => (
  <section className="flex flex-col gap-4 rounded-xl border bg-card p-6 shadow-card">
    <header className="flex flex-col gap-1">
      <h2 className="text-lg font-semibold tracking-tight">Shared accounts</h2>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        A shared GitHub, Google Drive or ClickUp account that Workers act with for people who
        haven't linked their own. Assign it to each person below. Someone's own link always wins.
      </p>
    </header>
    {view.accounts.length === 0 ? (
      <Empty title="No shared accounts yet" hint="Connect one below, then assign it to people." />
    ) : (
      <ul className="flex flex-col divide-y">
        {view.accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            people={view.assignments.filter((x) => x.sharedAccountId === a.id).length}
          />
        ))}
      </ul>
    )}
    <AddAccount />
  </section>
);

/** One person's shared account per connector, for members who have a channel identity. */
export const AssignCell = ({ member, view }: { member: Member; view: SharedAccountsView }) => {
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: (input: { provider: ConnectionProvider; sharedAccountId: string | null }) =>
      api.assignSharedAccount({
        channelType: member.channel!.type,
        personId: member.channel!.id,
        ...input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shared-accounts"] }),
  });
  if (!member.channel) return <span className="text-muted-foreground">Needs a Discord link</span>;
  const ownLink: Record<ConnectionProvider, boolean> = {
    github: member.github !== null,
    google: member.googleLinked,
    clickup: false,
  };
  const rows = CONNECTORS.flatMap((c) => {
    const options = view.accounts.filter((a) => a.provider === c.id);
    return options.length === 0 ? [] : [{ c, options }];
  });
  if (rows.length === 0) return <span className="text-muted-foreground">None to assign</span>;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ c, options }) => {
        const current = view.assignments.find(
          (a) =>
            a.provider === c.id &&
            a.channelType === member.channel!.type &&
            a.personId === member.channel!.id,
        );
        return (
          <div key={c.id} className="flex items-center gap-2">
            <c.Logo className="size-3.5 shrink-0" />
            <Select
              items={[
                { value: null, label: "None" },
                ...options.map((a) => ({ value: a.id, label: a.label })),
              ]}
              value={current?.sharedAccountId ?? null}
              onValueChange={(id) => assign.mutate({ provider: c.id, sharedAccountId: id })}
              disabled={assign.isPending}
            >
              <SelectTrigger aria-label={`${c.label} shared account`} className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value={null} className="text-xs">
                  None
                </SelectItem>
                {options.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="text-xs">
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ownLink[c.id] && <span className="text-xs text-muted-foreground">own link wins</span>}
          </div>
        );
      })}
      <Problem error={assign.error} />
    </div>
  );
};

export const SharedAccountsLoading = ({
  query,
}: {
  query: ReturnType<typeof useSharedAccounts>;
}) =>
  query.error ? (
    <QueryError error={query.error} />
  ) : (
    query.isPending && <Skeleton className="h-32 w-full rounded-xl" />
  );
