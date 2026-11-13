import type { ChannelType, ProjectSourceType } from "@project-os/contracts";
import { FolderOpen, GitBranch, Hash, List, Mail, MessageSquare } from "lucide-react";

export const SOURCE_META: Readonly<
  Record<ProjectSourceType, { readonly Icon: typeof Hash; readonly label: string }>
> = {
  discord_channel: { Icon: Hash, label: "Discord channel" },
  email_address: { Icon: Mail, label: "Email" },
  clickup_list: { Icon: List, label: "ClickUp list" },
  google_drive_folder: { Icon: FolderOpen, label: "Google Drive folder" },
  github_repo: { Icon: GitBranch, label: "GitHub repo" },
};

export const CHANNEL_META: Readonly<
  Record<ChannelType, { readonly Icon: typeof Hash; readonly label: string }>
> = {
  discord: SOURCE_META.discord_channel,
  email: SOURCE_META.email_address,
  chat: { Icon: MessageSquare, label: "Chat" },
};
