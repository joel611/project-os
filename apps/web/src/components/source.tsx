import type { ChannelType, ProjectSourceType } from "@project-os/contracts";
import type { ComponentType } from "react";
import { type SimpleIcon, siClickup, siDiscord, siGithub, siGoogledrive } from "simple-icons";
import { Blocks, FolderOpen, GitBranch, Hash, List, Mail, MessageSquare } from "lucide-react";
import type { SourceProvider } from "@/model";

type IconProps = {
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly role?: string;
};

type Icon = ComponentType<IconProps>;

/**
 * A provider's logo as inline SVG. `brand` paints it in the brand colour; without it the
 * logo follows the text colour, for marks like GitHub's that are near-black.
 */
const brandLogo = (icon: SimpleIcon, { brand }: { readonly brand: boolean }): Icon => {
  const Logo = (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill={brand ? `#${icon.hex}` : "currentColor"}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    >
      <path d={icon.path} />
    </svg>
  );
  Logo.displayName = `${icon.title}Logo`;
  return Logo;
};

const DiscordLogo = brandLogo(siDiscord, { brand: true });

export const PROVIDER_META: Readonly<
  Record<SourceProvider, { readonly Logo: Icon; readonly label: string }>
> = {
  github: { Logo: brandLogo(siGithub, { brand: false }), label: "GitHub" },
  google_drive: { Logo: brandLogo(siGoogledrive, { brand: true }), label: "Google Drive" },
  discord: { Logo: DiscordLogo, label: "Discord" },
  clickup: { Logo: brandLogo(siClickup, { brand: true }), label: "ClickUp" },
  email: { Logo: Mail, label: "Email" },
  other: { Logo: Blocks, label: "Other" },
};

export const SOURCE_META: Readonly<
  Record<ProjectSourceType, { readonly Icon: typeof Hash; readonly label: string }>
> = {
  discord_channel: { Icon: Hash, label: "Discord channel" },
  email_address: { Icon: Mail, label: "Email" },
  clickup_list: { Icon: List, label: "ClickUp list" },
  google_drive_folder: { Icon: FolderOpen, label: "Google Drive folder" },
  github_repo: { Icon: GitBranch, label: "GitHub repo" },
};

/** `SOURCE_META` for a type this build may not know yet. */
export const sourceMeta = (type: string): { readonly Icon: typeof Hash; readonly label: string } =>
  Object.hasOwn(SOURCE_META, type)
    ? SOURCE_META[type as ProjectSourceType]
    : { Icon: Blocks, label: type.replaceAll("_", " ") };

export const CHANNEL_META: Readonly<
  Record<ChannelType, { readonly Icon: Icon; readonly label: string }>
> = {
  discord: { Icon: DiscordLogo, label: "Discord" },
  email: SOURCE_META.email_address,
  chat: { Icon: MessageSquare, label: "Chat" },
};
