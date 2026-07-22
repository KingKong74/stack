#!/usr/bin/env bash
# Polaris project report + direction mind map (#225).
# Delegates all work to polaris_analysis.mjs (env loading, API calls, Gemini).
# Output: polaris/polaris_project_report.md + polaris/polaris_direction_map.md
exec node "$(dirname "$0")/polaris_analysis.mjs" "$@"
