import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitepress";

// Every page is a Markdown file that already lives in the repo; this folder only holds config.
const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Pages live outside this package, where `vue` can't be resolved; point them at the theme's copy.
const vueDir = path.dirname(createRequire(import.meta.url).resolve("vue/package.json"));
const repoUrl = "https://github.com/joel611/project-os";

// Source file (repo-relative) → site page. Links between files keep their GitHub paths and are
// mapped here, so the same Markdown reads correctly on GitHub and on the site.
const rewrites: Record<string, string> = {
  "docs/index.md": "index.md",
  "docs/why.md": "why.md",
  "docs/product-brief.md": "product-brief.md",
  "docs/how-it-works.md": "how-it-works.md",
  "docs/quick-start.md": "guide/quick-start.md",
  "SETUP.md": "guide/setup.md",
  "TESTING.md": "guide/testing.md",
  "docs/deployment.md": "guide/deployment.md",
  "docs/development.md": "guide/development.md",
  "docs/technical-architecture.md": "reference/architecture.md",
  "docs/infra-cloudflare.md": "reference/infra-cloudflare.md",
  "CONTEXT.md": "reference/glossary.md",
};

const pageFor = (source: string): string | undefined => {
  if (source === "README.md") return "/";
  return rewrites[source] ? "/" + rewrites[source].replace(/(index)?\.md$/, "") : undefined;
};

// VitePress renders a page with its rewritten path; links must resolve from the source file.
const sourceOf = (file: string): string => {
  if (file in rewrites || existsSync(path.join(repoRoot, file))) return file;
  const exact = Object.entries(rewrites).find(([, page]) => page === file);
  return exact ? exact[0] : file;
};

const isRelative = (href: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href);

export default defineConfig({
  title: "project-os",
  description: "The open-source control tower for your team's AI agents.",
  // Project Pages URL: https://joel611.github.io/project-os/. Set SITE_BASE=/ for a custom domain.
  base: process.env.SITE_BASE ?? "/project-os/",
  srcDir: repoRoot,
  srcExclude: [
    "README.md",
    "CLAUDE.md",
    "apps/**",
    "packages/**",
    "libs/**",
    "stacks/**",
    "scripts/**",
    ".changeset/**",
    ".github/**",
    // Internal docs: links to them go to GitHub instead.
    "docs/adr/**",
    "docs/agents/**",
    "docs/research/**",
    "docs/demo/**",
  ],
  rewrites,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  vite: { resolve: { alias: [{ find: /^vue(?=\/|$)/, replacement: vueDir }] } },
  markdown: {
    config: (md) => {
      // Resolve repo-relative links from the source file: Markdown pages go to their site URL,
      // anything else (LICENSE, .env.example, source files) goes to GitHub.
      md.core.ruler.push("repo-links", (state) => {
        const from = path.dirname(sourceOf(path.relative(repoRoot, state.env.path ?? "")));
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            if (token.type !== "link_open") continue;
            const href = token.attrGet("href");
            if (!href || !isRelative(href)) continue;
            const [file, hash] = href.split("#");
            const target = path.normalize(path.join(from, decodeURIComponent(file)));
            const page = target.endsWith(".md") ? pageFor(target) : undefined;
            if (page) token.attrSet("href", page + (hash ? `#${hash}` : ""));
            else if (existsSync(path.join(repoRoot, target)))
              token.attrSet("href", `${repoUrl}/blob/main/${target}${hash ? `#${hash}` : ""}`);
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
          { text: "Glossary", link: "/reference/glossary" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: [2, 3],
    socialLinks: [{ icon: "github", link: repoUrl }],
    // Serialized to the browser, so it can only use its argument.
    editLink: {
      pattern: ({ filePath }) => `https://github.com/joel611/project-os/edit/main/${filePath}`,
      text: "Edit this page on GitHub",
    },
    footer: { message: "Released under the MIT License." },
  },
});
