import { createFileRoute } from "@tanstack/react-router";
import { MembersView } from "@/components/members-view";

export const Route = createFileRoute("/members")({ component: MembersView });
