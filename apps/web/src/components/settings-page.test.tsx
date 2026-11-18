// @vitest-environment happy-dom
import type { ProjectSource } from "@project-os/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api } from "@/api";
import { ProjectSources } from "./settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const repo: ProjectSource = {
  id: "repo-1",
  projectId: "project-1",
  type: "github_repo",
  alias: "web",
  externalId: "acme/web",
  name: "acme/web",
  description: null,
  direction: "inbound",
  config: {},
  status: "active",
  connectedBy: null,
  updatedAt: "2026-11-17T00:00:00.000Z",
  isDefaultResponse: false,
  createdAt: "2026-11-17T00:00:00.000Z",
};

const show = (sources: ProjectSource[] = []) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectSources projectId="project-1" sources={sources} />
    </QueryClientProvider>,
  );
};

it("always shows supported providers and plus actions when empty", () => {
  show();
  expect(screen.getByRole("region", { name: "GitHub" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Google Drive" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add GitHub" }).querySelector("svg")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add Google Drive" })).toBeTruthy();
  expect(screen.queryByLabelText("Source link")).toBeNull();
});

it("groups linked sources without hiding empty providers", () => {
  show([repo]);
  expect(within(screen.getByRole("region", { name: "GitHub" })).getByText("web")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add your first folder" })).toBeTruthy();
});

it("opens a focused form and still auto-detects either provider", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Add Google Drive" }));
  const link = screen.getByLabelText("Source link");
  expect(document.activeElement).toBe(link);
  fireEvent.change(link, { target: { value: "https://github.com/acme/web" } });
  expect((screen.getByLabelText("Alias") as HTMLInputElement).value).toBe("web");
  expect(screen.getByText("GitHub repo · acme/web")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Alias"), { target: { value: "design-docs" } });
  fireEvent.change(link, {
    target: { value: "https://drive.google.com/drive/folders/1AbCdEfGhIjK" },
  });
  expect(screen.getByText("Google Drive folder · 1AbCdEfGhIjK")).toBeTruthy();
  expect((screen.getByLabelText("Alias") as HTMLInputElement).value).toBe("design-docs");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Source link")).toBeNull();
});

it("submits a detected source and closes the form on success", async () => {
  const add = vi.spyOn(api, "addSource").mockResolvedValue(repo);
  show();
  fireEvent.click(screen.getByRole("button", { name: "Add source" }));
  fireEvent.change(screen.getByLabelText("Source link"), {
    target: { value: "https://github.com/acme/web" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Add source" })[1]!);
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        type: "github_repo",
        externalId: "acme/web",
        alias: "web",
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByLabelText("Source link")).toBeNull());
});

it("keeps duplicate validation before sending a source", () => {
  const add = vi.spyOn(api, "addSource");
  show([repo]);
  fireEvent.click(screen.getByRole("button", { name: "Add GitHub" }));
  fireEvent.change(screen.getByLabelText("Source link"), {
    target: { value: "https://github.com/acme/web" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Add source" })[1]!);
  expect(screen.getByRole("alert").textContent).toContain("already linked");
  expect(add).not.toHaveBeenCalled();
});
