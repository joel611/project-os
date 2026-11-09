export const DEFAULT_WATCHER_INSTALL = "bun install -g @project-os/watcher";

export const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

const trimmed = (url: string) => url.replace(/\/+$/, "");

export interface ScriptConfig {
  readonly server: string;
  readonly installCommand?: string;
}

export interface InstallChoices {
  readonly name?: string | undefined;
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
  readonly yes?: boolean | undefined;
}

export const installLine = (
  config: ScriptConfig,
  token: string,
  { name, agent, model, yes }: InstallChoices = {},
): string =>
  [
    `curl -fsSL ${shellQuote(`${trimmed(config.server)}/watcher/install.sh`)} | sh -s -- ${token}`,
    ...(name ? ["--name", shellQuote(name)] : []),
    ...(agent ? ["--agent", shellQuote(agent)] : []),
    ...(model ? ["--model", shellQuote(model)] : []),
    ...(yes ? ["--yes"] : []),
  ].join(" ");

// The script reads answers from the terminal, not stdin, because stdin is the curl pipe. The
// terminal is opened once on fd 3 so a file standing in for it (PROJECT_OS_INSTALL_TTY, used by
// tests) is read line by line. Prompts go to stderr.
const TTY_HELPERS = `tty=\${PROJECT_OS_INSTALL_TTY:-/dev/tty}
asking=""
if (: <"$tty") 2>/dev/null; then exec 3<"$tty"; asking=1; fi
can_ask() { [ -n "$asking" ]; }
ask() {
  printf '%s' "$1" >&2
  IFS= read -r reply <&3 || reply=""
}`;

export const installScript = (config: ScriptConfig): string => `#!/bin/sh
# Installs the Project OS Watcher on this computer and registers it.
# Usage: curl -fsSL ${trimmed(config.server)}/watcher/install.sh | sh -s -- <code> [--name N] [--agent A] [--model M] [--yes]
# --yes never asks: it uses --agent (else the first agent found) and --model (else the agent's default).
set -eu

server=${shellQuote(trimmed(config.server))}
${TTY_HELPERS}

code=""; name=""; agent=""; model=""; yes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) yes=1; shift ;;
    --name|--agent|--model)
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in --name) name=$2 ;; --agent) agent=$2 ;; --model) model=$2 ;; esac
      shift 2 ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) code=$1; shift ;;
  esac
done
[ -n "$code" ] || { echo "Usage: sh -s -- <code> [--name N] [--agent claude|pi|codex] [--model M] [--yes]" >&2; exit 2; }
if [ -n "$yes" ]; then asking=""; fi

found=""
for candidate in claude pi codex; do
  if command -v "$candidate" >/dev/null 2>&1; then found="$found $candidate"; fi
done

if [ -n "$agent" ]; then
  case "$agent" in
    claude|pi|codex) ;;
    *) echo "--agent must be claude, pi or codex" >&2; exit 2 ;;
  esac
  command -v "$agent" >/dev/null 2>&1 || echo "Warning: $agent isn't installed on this computer yet." >&2
else
  [ -n "$found" ] || {
    echo "No agent CLI found. Install Claude Code (claude), Pi (pi) or Codex (codex), then run this again." >&2
    exit 1
  }
  set -- $found
  if can_ask; then
    echo "Agents found on this computer:"
    i=1
    for a in "$@"; do echo "  $i) $a"; i=$((i + 1)); done
    ask "Which agent should work your tickets? [1] "
    pick=\${reply:-1}
    i=1
    for a in "$@"; do
      if [ "$pick" = "$i" ] || [ "$pick" = "$a" ]; then agent=$a; fi
      i=$((i + 1))
    done
    [ -n "$agent" ] || { echo "Not a choice: $pick" >&2; exit 1; }
  elif [ $# -eq 1 ] || [ -n "$yes" ]; then
    agent=$1
  else
    echo "Several agents found:$found. Run this again with --agent <name> (or --yes for the first)." >&2
    exit 1
  fi
fi

if [ -z "$model" ] && can_ask; then
  ask "Model for $agent (Enter for its default): "
  model=$reply
fi

export PATH="$HOME/.bun/bin:$PATH"
${config.installCommand ?? DEFAULT_WATCHER_INSTALL}

set -- register "$code" --server "$server" --agent "$agent"
if [ -n "$name" ]; then set -- "$@" --name "$name"; fi
if [ -n "$model" ]; then set -- "$@" --model "$model"; fi
exec project-os-watcher "$@"
`;
