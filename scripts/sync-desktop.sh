#!/usr/bin/env bash
# Claude Desktop runs Claude Code on Windows, which cannot load a mod from the WSL filesystem,
# so this copies the mod into the Windows profile's own mods folder, %USERPROFILE%\.claude\skills\leet.
set -euo pipefail
mod="$(cd "$(dirname "$0")/.." && pwd)"
profile="$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")"
mkdir -p "$profile/.claude/skills/leet"
rsync -a --delete --exclude '.git' --exclude '.claude-plugin/types' --exclude 'tsconfig.json' "$mod/" "$profile/.claude/skills/leet/"
