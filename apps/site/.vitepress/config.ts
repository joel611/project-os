import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitepress";

// Every page is a Markdown file in this folder, at the path of its URL. Links that leave the
// folder (the glossary, ADRs, source files) resolve from the file and go to GitHub, so the same
// Markdown reads correctly on GitHub and on the site.
const siteDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(siteDir, "../..");
const repoUrl = "https://github.com/joel611/project-os";

const isRelative = (href: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href);

export default defineConfig({
  title: "project-os",
  description: "The open-source control tower for your team's AI agents.",
  // Project Pages URL: https://joel611.github.io/project-os/. Set SITE_BASE=/ for a custom domain.
  base: process.env.SITE_BASE ?? "/project-os/",
  srcExclude: ["CHANGELOG.md"],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  markdown: {
    config: (md) => {
      // Relative links that leave this folder go to the file on GitHub.
      md.core.ruler.push("repo-links", (state) => {
        const from = path.dirname(state.env.path ?? siteDir);
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            if (token.type !== "link_open") continue;
            const href = token.attrGet("href");
            if (!href || !isRelative(href)) continue;
            const [file, hash] = href.split("#");
            const target = path.resolve(from, decodeURIComponent(file));
            if (!path.relative(siteDir, target).startsWith("..")) continue;
            if (existsSync(target)) {
              const repoPath = path.relative(repoRoot, target);
              token.attrSet("href", `${repoUrl}/blob/main/${repoPath}${hash ? `#${hash}` : ""}`);
            }
          }
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: "Why", link: "/why" },
      { text: "How it works", link: "/how-it-works" },
      { text: "Guide", link: "/guide/quick-start" },
      { text: "Reference", link: "/reference/architecture" },
    ],
    sidebar: [
      {
        text: "Product",
        items: [
          { text: "Why project-os", link: "/why" },
          { text: "How it works", link: "/how-it-works" },
          { text: "Product brief", link: "/product-brief" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Quick start", link: "/guide/quick-start" },
          { text: "Setup", link: "/guide/setup" },
          { text: "Deploy to Cloudflare", link: "/guide/deployment" },
          { text: "Testing without Discord", link: "/guide/testing" },
          { text: "Development", link: "/guide/development" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Environment variables", link: "/guide/setup#environment" },
          { text: "Technical architecture", link: "/reference/architecture" },
          { text: "Cloudflare infrastructure", link: "/reference/infra-cloudflare" },
          { text: "Glossary", link: `${repoUrl}/blob/main/CONTEXT.md` },
        ],
      },
    ],
    search: { provider: "local" },
    outline: [2, 3],
    socialLinks: [{ icon: "github", link: repoUrl }],
    // Serialized to the browser, so it can only use its argument.
    editLink: {
      pattern: ({ filePath }) =>
        `https://github.com/joel611/project-os/edit/main/apps/site/${filePath}`,
      text: "Edit this page on GitHub",
    },
    footer: { message: "Released under the MIT License." },
  },
});
