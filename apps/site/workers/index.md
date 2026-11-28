# Workers

A worker does the research for a ticket. It runs on a computer you register, or in a cloud sandbox.

| Worker                             | Runs on                           | Takes                                      |
| ---------------------------------- | --------------------------------- | ------------------------------------------ |
| [Local computer](local.md)         | A developer's or a team computer  | Its owner's tickets, or anyone's if shared |
| [Cloud sandbox](cloud-sandbox.md)  | A fresh sandbox for each ticket   | Tickets no registered computer takes       |

A ticket can also bring skills to its worker. See [How skills reach a worker](skills.md).

## Which worker takes a ticket

A new ticket goes to the requester's own computer if it's online, else to an online shared computer with room, else to a [cloud sandbox](cloud-sandbox.md). If none of them has room, the ticket is **queued**: its thread says so, and the health sweep assigns it as soon as something frees up. Nothing runs tickets unless at least one of these is set up.
