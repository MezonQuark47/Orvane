# Build all Daml packages and run the Daml Script test suite.
# Usage (from repo root):  ./scripts/test.ps1
$ErrorActionPreference = 'Stop'

# Under a Turkish system locale the JVM upper-cases "i" to a dotted capital I,
# which breaks Daml-LF name validation. Force an English JVM locale.
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'daml')
try {
    dpm build --all
    Push-Location 'orvane-amm-test'
    try { dpm test } finally { Pop-Location }
} finally {
    Pop-Location
}
