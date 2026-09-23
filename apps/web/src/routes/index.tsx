import { createFileRoute } from "@tanstack/react-router";

const Home = () => (
  <main>
    <h1>project-os</h1>
  </main>
);

export const Route = createFileRoute("/")({
  component: Home,
});
