#!/usr/bin/env bash
# Builds the ZIP for OpenAI's plugin portal (platform.openai.com/plugins):
# plugin.json and mcp.json from plugin/openai, the logo and the skill from
# the Claude plugin in plugin/dawmain, so both listings share one source.
# Usage: DEMO_RECORDING_URL=https://... scripts/build-openai-plugin.sh [out.zip]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist/dawmain-openai-plugin.zip}"
: "${DEMO_RECORDING_URL:?set DEMO_RECORDING_URL to a reviewer-accessible demo video}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/assets" "$stage/skills/dawmain-reserse" "$(dirname "$out")"
sed "s|__DEMO_RECORDING_URL__|$DEMO_RECORDING_URL|" "$root/plugin/openai/plugin.json" > "$stage/plugin.json"
cp "$root/plugin/openai/mcp.json" "$stage/mcp.json"
cp "$root/plugin/dawmain/logo.png" "$stage/assets/logo.png"
cp "$root/plugin/dawmain/skills/dawmain-reserse/SKILL.md" "$stage/skills/dawmain-reserse/SKILL.md"
rm -f "$out"
(cd "$stage" && zip -qrX "$out" plugin.json mcp.json assets skills)
echo "$out"
