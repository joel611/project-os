import { defineConfig } from "vite-plus";

// Dependency rules from docs/technical-architecture.md §8.4.
const providerImports = [
  {
    name: "drizzle-orm",
    message: "core is provider-free; put Drizzle code in packages/db-sqlite.",
  },
  { name: "elysia", message: "core is provider-free; HTTP lives in apps/*." },
  { name: "bun", message: "core is provider-free; Bun APIs live in infra-local or apps/*." },
  { name: "@project-os/db-sqlite", message: "core must not depend on adapters." },
  { name: "@project-os/infra-local", message: "core must not depend on providers." },
  { name: "@project-os/infra-cloudflare", message: "core must not depend on providers." },
];
const edgeOnly = [
  "@project-os/core",
  "@project-os/db-sqlite",
  "@project-os/infra-local",
  "@project-os/infra-cloudflare",
].map((name) => ({
  name,
  message: "adapters and the watcher may only use contracts + libs/config.",
}));

export default defineConfig({
  staged: {
    "*.{js,jsx,ts,tsx,json,jsonc,css,md,mdx}": "vp check --fix",
    "*.{ts,tsx,js,jsx}": "vp test related --run --passWithNoTests",
  },
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "libs/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts", "libs/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/main.*.ts", "**/dist/**", "**/migrations/**", "**/index.ts"],
      reporter: ["text", "html", "json", "json-summary"],
      reportOnFailure: true,
      // Floor = measured baseline, rounded down. The floor only rises.
      thresholds: { lines: 28, functions: 50, branches: 100, statements: 31 },
    },
  },
  lint: {
    plugins: ["typescript"],
    ignorePatterns: ["**/dist/**", "**/migrations/**"],
    overrides: [
      {
        files: ["packages/core/**", "packages/contracts/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: providerImports,
              patterns: [
                {
                  group: ["drizzle-orm/*", "elysia/*", "bun:*", "cloudflare:*"],
                  message: "core is provider-free.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/discord-adapter/**", "apps/email-adapter/**", "apps/watcher/**"],
        rules: { "no-restricted-imports": ["error", { paths: edgeOnly }] },
      },
    ],
  },
  fmt: {
    printWidth: 100,
    ignorePatterns: ["**/migrations/**", "bun.lock", "docs/**", "CONTEXT.md", "CLAUDE.md"],
  },
});
