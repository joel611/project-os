import { createFileRoute } from "@tanstack/react-router";
import { MyTicketsView } from "@/components/my-tickets";

export const Route = createFileRoute("/mine")({ component: MyTicketsView });
