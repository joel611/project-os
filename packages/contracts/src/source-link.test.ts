import { describe, expect, it } from "vite-plus/test";
import { detectSource, suggestAlias } from "./source-link.ts";

describe("detectSource", () => {
  it.each([
    ["https://github.com/acme/web", "github_repo", "acme/web"],
    ["https://github.com/acme/web.git", "github_repo", "acme/web"],
    ["https://github.com/acme/web/tree/main/src", "github_repo", "acme/web"],
    ["acme/web", "github_repo", "acme/web"],
    ["Acme/Web", "github_repo", "acme/web"],
    [
      "https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing",
      "google_drive_folder",
      "1AbCdEfGhIjK",
    ],
    [
      "https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjK",
      "google_drive_folder",
      "1AbCdEfGhIjK",
    ],
    ["drive.google.com/drive/folders/1AbCdEfGhIjK", "google_drive_folder", "1AbCdEfGhIjK"],
    ["1AbCdEfGhIjK", "google_drive_folder", "1AbCdEfGhIjK"],
  ])("%s -> %s", (raw, type, id) => {
    expect(detectSource(raw)).toMatchObject({ type, externalId: id });
  });

  it.each(["", "not a repo", "short"])("rejects %j", (raw) => {
    expect(detectSource(raw)).toBeNull();
  });
});

describe("suggestAlias", () => {
  it("names a repo after itself and leaves a Drive folder for the operator", () => {
    expect(suggestAlias(detectSource("https://github.com/acme/Web.App"))).toBe("web-app");
    expect(suggestAlias(detectSource("1AbCdEfGhIjK"))).toBe("");
    expect(suggestAlias(null)).toBe("");
  });
});
