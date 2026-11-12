---
"@project-os/core": minor
"@project-os/db-sqlite": minor
"@project-os/testing": minor
"@project-os/coordinator": minor
"@project-os/web": minor
---

Let dashboard operators remove a project source. `DELETE /projects/:id/sources/:sourceId` unlinks it (operators only), and the project settings page has a Remove button that asks for confirmation first. A removed channel stops routing messages to the project and can be linked again; Workers no longer see the source.
