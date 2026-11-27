# Connectors

Connectors let project-os reach the places where your project's work lives.

| Connector             | Used for                        | Can be a project source |
| --------------------- | ------------------------------- | ----------------------- |
| [GitHub](github.md)   | Code, pull requests, and issues | Yes, a repository       |
| [Google](google.md)   | Documents in Google Drive       | Yes, a Drive folder     |
| [ClickUp](clickup.md) | Files attached to ClickUp tasks | No                      |

A **project source** tells project-os which repository or folder a project is about. Add one with `/source-add` in Discord, or in the dashboard.

## Your own access

Run `/connect` in Discord to link your own account. When you ask a question, project-os works with your access. Use `/connections` to see what is linked and `/disconnect` to unlink.

An admin can also assign a shared team account in the dashboard. It is used only for people who never linked their own account.

If a question needs an account that is not linked, project-os asks you to connect it.
