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
      // ```mermaid fences render as diagrams (theme/Mermaid.vue).
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (...args) => {
        const [tokens, index] = args;
        const token = tokens[index]!;
        if (token.info.trim() !== "mermaid") return fence(...args);
        return `<Mermaid code="${encodeURIComponent(token.content)}" />`;
      };

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
      // `activeMatch` keeps one entry highlighted on every page. The Cloudflare infrastructure
      // page sits under reference/ but belongs to the Deployment docs.
      {
        text: "Doc",
        link: "/why",
        activeMatch: "^/(why|how-it-works|guide|channels|connectors|workers|reference/infra)",
      },
      { text: "Reference", link: "/reference/environment", activeMatch: "^/reference/(?!infra)" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Why project-os", link: "/why" },
          { text: "How it works", link: "/how-it-works" },
          { text: "Quick start", link: "/guide/quick-start" },
          { text: "Configuration", link: "/guide/setup" },
        ],
      },
      {
        text: "Inbound channels",
        items: [
          { text: "Overview", link: "/channels/" },
          { text: "Discord", link: "/channels/discord" },
          { text: "Email", link: "/channels/email" },
        ],
      },
      {
        text: "Connectors",
        items: [
          { text: "Overview", link: "/connectors/" },
          { text: "GitHub", link: "/connectors/github" },
          { text: "Google Drive", link: "/connectors/google" },
          { text: "ClickUp", link: "/connectors/clickup" },
        ],
      },
      {
        text: "Workers",
        items: [
          { text: "Overview", link: "/workers/" },
          { text: "Local computer", link: "/workers/local" },
          { text: "Cloud sandbox", link: "/workers/cloud-sandbox" },
        ],
      },
      {
        text: "Deployment",
        items: [
          { text: "Cloudflare", link: "/guide/deployment" },
          { text: "Cloudflare infrastructure", link: "/reference/infra-cloudflare" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Environment variables", link: "/reference/environment" },
          { text: "Technical architecture", link: "/reference/architecture" },
          { text: "Troubleshooting", link: "/reference/troubleshooting" },
          { text: "Glossary", link: `${repoUrl}/blob/main/CONTEXT.md` },
        ],
      },
      {
        text: "Contributing",
        items: [
          { text: "Development", link: "/guide/development" },
          { text: "Testing without Discord", link: "/guide/testing" },
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
