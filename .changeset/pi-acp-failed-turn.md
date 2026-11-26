---
"@project-os/pi-acp": patch
---

A Pi turn whose model call fails (a bad key, a provider outage after Pi's retries) now fails the ACP prompt with Pi's error message, so the Watcher records the run as failed instead of succeeded.
