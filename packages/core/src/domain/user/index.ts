export type UserRole = "admin" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly orgId: string;
  readonly createdAt: string;
}

export const isAdmin = (user: User): boolean => user.role === "admin";
