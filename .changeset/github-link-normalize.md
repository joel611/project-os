---
"@project-os/contracts": patch
"@project-os/core": patch
"@project-os/coordinator": patch
"@project-os/web": patch
---

Accept GitHub repo links in any common form when adding a project source: no `https://`, `www.`, a trailing `.git` or `/`, the SSH remote `git@github.com:owner/repo.git`, or `owner/repo`. They are stored as canonical `owner/repo`. Links that aren't a GitHub repo (`github.com/owner`, `gitlab.com/owner/repo`) are rejected with a clear message, and the API returns `400 InvalidSourceLink`.
