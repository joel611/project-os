import { createFileRoute } from "@tanstack/react-router";
import { EmailView } from "@/components/email-view";

export const Route = createFileRoute("/email")({ component: EmailView });
