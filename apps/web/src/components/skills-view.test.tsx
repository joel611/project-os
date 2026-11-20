// @vitest-environment happy-dom
import type { SkillCandidates, SkillSetDetail } from "@project-os/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api } from "@/api";
import { AddSkillsDialog } from "./skills-view";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const set: SkillSetDetail = {
  set: { id: "set-1", name: "Development", description: "", createdAt: "", updatedAt: "" },
  skills: [],
};
const candidates: SkillCandidates = {
  source: "acme/skills",
  skills: ["alpha", "beta"].map((slug) => ({
    source: "acme/skills",
    slug,
    name: slug,
    description: "",
    path: `skills/${slug}`,
  })),
};
const show = () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddSkillsDialog set={set} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
};
const find = () => {
  fireEvent.change(screen.getByLabelText("Skills source"), { target: { value: "acme/skills" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
};

it("selects every fetched skill, clears all, and supports individual changes", async () => {
  vi.spyOn(api, "browseSkills").mockResolvedValue(candidates);
  const add = vi.spyOn(api, "addSkills").mockResolvedValue(set);
  show();
  expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  find();
  fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
  expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
  expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true);
  expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Download 2" }));
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith("set-1", {
      source: "acme/skills",
      slugs: ["alpha", "beta"],
    }),
  );
});

it("resets selection when another source is fetched and hides controls for empty results", async () => {
  const browse = vi.spyOn(api, "browseSkills").mockResolvedValue(candidates);
  show();
  find();
  fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
  browse.mockResolvedValue({
    source: "acme/other",
    skills: [
      { source: "acme/other", slug: "gamma", name: "gamma", path: "gamma", description: "" },
    ],
  });
  fireEvent.change(screen.getByLabelText("Skills source"), { target: { value: "acme/other" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByRole("checkbox", { name: "gamma" });
  expect(screen.getByText("0 of 1 selected")).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  browse.mockResolvedValue({ source: "acme/empty", skills: [] });
  fireEvent.change(screen.getByLabelText("Skills source"), { target: { value: "acme/empty" } });
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText("No skills found in acme/empty.");
  expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Deselect all" })).toBeNull();
});
