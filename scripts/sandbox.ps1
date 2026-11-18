# Build the contracts and start a local Canton sandbox with them loaded.
# JSON Ledger API: http://localhost:6864   gRPC: 6865
# Usage (from repo root):  ./scripts/sandbox.ps1
$ErrorActionPreference = 'Stop'
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'daml')
try { dpm build --all } finally { Pop-Location }

$dar = Join-Path $root 'daml/orvane-amm/.daml/dist/orvane-defi-amm-0.1.0.dar'
$work = Join-Path $root '.sandbox'
New-Item -ItemType Directory -Force $work | Out-Null
Push-Location $work
try { dpm sandbox --dar $dar } finally { Pop-Location }
