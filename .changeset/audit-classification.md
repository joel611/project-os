---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/agent-runtime": minor
"@project-os/web": minor
---

Log what the decision model made of each inbound message. Messages that reach the classifier get a second `inbound_event` audit row, `classified` (or `classify_failed`), written once the outcome is known: the intent and executor answers with every option's probability, the confidence threshold, the model, and what the Coordinator did next (ticket created, follow-up added, asked to clarify, or failed with its error). The row links the ticket it created. On the Audit log page, a classified row's Details show each option's probability as a bar with the threshold marked. No migration: it all lives in the row's payload.
