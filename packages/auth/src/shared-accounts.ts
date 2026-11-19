import type {
  AssignSharedAccount,
  ConnectionProvider,
  SharedAccount,
  SharedAccountsView,
  SharedAssignment,
} from "@project-os/contracts";
import { schema, type SqliteDb } from "@project-os/db-sqlite";
import type { Person, UserAccessToken } from "@project-os/core";
import { and, asc, eq } from "drizzle-orm";
import type { BetterAuth } from "./auth.ts";
import type { Connections } from "./connections.ts";

const SHARED_DOMAIN = "@shared.project-os.invalid";

/** Whether an auth user stands for a shared account rather than a person. */
export const isSharedAccountEmail = (email: string) => email.toLowerCase().endsWith(SHARED_DOMAIN);

const emailFor = (id: string) => `shared-${id}${SHARED_DOMAIN}`;

type AccountRow = typeof schema.sharedAccounts.$inferSelect;

/** The shared account assigned to `person` for `provider`: what `UserConnections` falls back to. */
export const sharedLookup =
  (db: SqliteDb) => async (person: Person, provider: ConnectionProvider) => {
    const [row] = await db
      .select({
        id: schema.sharedAccounts.id,
        label: schema.sharedAccounts.label,
        userId: schema.sharedAccounts.userId,
      })
      .from(schema.sharedAccountAssignments)
      .innerJoin(
        schema.sharedAccounts,
        eq(schema.sharedAccounts.id, schema.sharedAccountAssignments.sharedAccountId),
      )
      .where(
        and(
          eq(schema.sharedAccountAssignments.channelType, person.channelType),
          eq(schema.sharedAccountAssignments.personId, person.id),
          eq(schema.sharedAccountAssignments.provider, provider),
        ),
      )
      .limit(1);
    return row;
  };

/** What an assignment call can refuse. */
export type AssignResult =
  | { readonly ok: true; readonly account: SharedAccount | null }
  | { readonly ok: false; readonly error: "not_found" | "provider_mismatch" };

/**
 * Shared accounts: team-wide GitHub / Google / ClickUp links an admin makes with the same OAuth
 * flow as `/connect`. Each is an auth user of its own whose `account` row holds the encrypted
 * tokens; an assignment points one person at it for one provider.
 */
export const makeSharedAccounts = (db: SqliteDb, auth: BetterAuth, connections: Connections) => {
  const toAccount = async (row: AccountRow): Promise<SharedAccount> => {
    const linked = (await connections.forUser.linkedAccounts(row.userId)).find(
      (a) => a.provider === row.provider,
    );
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      identity: linked?.displayIdentity ?? null,
      connected: linked !== undefined,
      createdAt: row.createdAt,
    };
  };

  const find = async (id: string) =>
    (await db.select().from(schema.sharedAccounts).where(eq(schema.sharedAccounts.id, id)))[0];

  const connectUrl = (row: AccountRow) => connections.forUser.connectLink(row.userId, row.provider);

  return {
    accessToken: async (provider: ConnectionProvider): Promise<UserAccessToken | null> => {
      const rows = await db
        .select()
        .from(schema.sharedAccounts)
        .where(eq(schema.sharedAccounts.provider, provider))
        .orderBy(asc(schema.sharedAccounts.createdAt), asc(schema.sharedAccounts.id));
      for (const row of rows) {
        const token = await connections.forUser.accessToken(row.userId, provider);
        if (token?.accessToken) return token;
      }
      return null;
    },

    list: async (): Promise<SharedAccountsView> => {
      const rows = await db.select().from(schema.sharedAccounts);
      const assignments = await db.select().from(schema.sharedAccountAssignments);
      return {
        accounts: (await Promise.all(rows.map(toAccount))).toSorted(
          (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
        ),
        assignments: assignments.map((a): SharedAssignment => ({
          channelType: a.channelType as SharedAssignment["channelType"],
          personId: a.personId,
          provider: a.provider,
          sharedAccountId: a.sharedAccountId,
          assignedAt: a.assignedAt,
        })),
      };
    },

    /** A new, not yet connected shared account, and the link that connects it. */
    create: async (input: {
      readonly provider: ConnectionProvider;
      readonly label: string;
      readonly createdBy: string;
    }) => {
      const id = crypto.randomUUID();
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.createUser(
        { email: emailFor(id), name: input.label, emailVerified: false },
        { method: "shared-account" },
      );
      const row: AccountRow = {
        id,
        provider: input.provider,
        label: input.label,
        userId: user.id,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
      };
      await db.insert(schema.sharedAccounts).values(row);
      return { account: await toAccount(row), connectUrl: await connectUrl(row) };
    },

    /** A fresh link for an existing shared account: finishing it, or replacing a dead token. */
    reconnect: async (id: string) => {
      const row = await find(id);
      if (!row) return undefined;
      return { account: await toAccount(row), connectUrl: await connectUrl(row) };
    },

    /** Deletes the account, its tokens and every assignment to it. */
    remove: async (id: string): Promise<SharedAccount | undefined> => {
      const row = await find(id);
      if (!row) return undefined;
      const account = await toAccount(row);
      await db
        .delete(schema.sharedAccountAssignments)
        .where(eq(schema.sharedAccountAssignments.sharedAccountId, id));
      await db.delete(schema.sharedAccounts).where(eq(schema.sharedAccounts.id, id));
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUser(row.userId);
      return account;
    },

    /** Points `person` at a shared account for a provider; a null id removes the assignment. */
    assign: async (
      input: AssignSharedAccount & { readonly assignedBy: string },
    ): Promise<AssignResult> => {
      const where = and(
        eq(schema.sharedAccountAssignments.channelType, input.channelType),
        eq(schema.sharedAccountAssignments.personId, input.personId),
        eq(schema.sharedAccountAssignments.provider, input.provider),
      );
      if (input.sharedAccountId === null) {
        const [previous] = await db
          .select({ id: schema.sharedAccountAssignments.sharedAccountId })
          .from(schema.sharedAccountAssignments)
          .where(where);
        if (!previous) return { ok: true, account: null };
        await db.delete(schema.sharedAccountAssignments).where(where);
        // The foreign key keeps an assignment from outliving its account.
        return { ok: true, account: await toAccount((await find(previous.id))!) };
      }
      const row = await find(input.sharedAccountId);
      if (!row) return { ok: false, error: "not_found" };
      if (row.provider !== input.provider) return { ok: false, error: "provider_mismatch" };
      const values = {
        channelType: input.channelType,
        personId: input.personId,
        provider: input.provider,
        sharedAccountId: row.id,
        assignedBy: input.assignedBy,
        assignedAt: new Date().toISOString(),
      };
      await db
        .insert(schema.sharedAccountAssignments)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.sharedAccountAssignments.channelType,
            schema.sharedAccountAssignments.personId,
            schema.sharedAccountAssignments.provider,
          ],
          set: {
            sharedAccountId: values.sharedAccountId,
            assignedBy: values.assignedBy,
            assignedAt: values.assignedAt,
          },
        });
      return { ok: true, account: await toAccount(row) };
    },
  };
};

export type SharedAccounts = ReturnType<typeof makeSharedAccounts>;
