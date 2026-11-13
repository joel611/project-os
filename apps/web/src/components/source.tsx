import type { ChannelType, ProjectSourceType } from "@project-os/contracts";
import type { ComponentType } from "react";
import { siDiscord } from "simple-icons";
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

type IconProps = {
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly role?: string;
};

const DiscordLogo = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d={siDiscord.path} />
  </svg>
);

export const CHANNEL_META: Readonly<
  Record<ChannelType, { readonly Icon: ComponentType<IconProps>; readonly label: string }>
> = {
  discord: { Icon: DiscordLogo, label: "Discord" },
  email: SOURCE_META.email_address,
  chat: { Icon: MessageSquare, label: "Chat" },
};
