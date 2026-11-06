# Changesets

This folder holds pending release notes, managed by [`@changesets/cli`](https://changesets.dev).

## Adding a changeset

When a PR changes a package in a way users or other packages should know about, run:

```sh
bun run changeset
```

Pick the affected packages, choose a bump (`patch` / `minor` / `major`), and write a one-line summary. Commit the generated `.changeset/*.md` file with the PR. Docs-only, test-only, and CI-only changes don't need one.

## Releasing

On every push to `main`, the **Release** workflow (`.github/workflows/release.yml`) collects pending changesets into a **"chore: version packages"** PR that bumps versions and writes each package's `CHANGELOG.md`. Merging that PR runs `bun run release`, which publishes any public (non-`private`) package to npm and pushes git tags. Private packages are versioned and get changelogs but are never published.
