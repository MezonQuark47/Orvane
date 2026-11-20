# Build all Daml packages, run the Daml Script suite and the TypeScript unit tests.
# Usage (from repo root):  ./scripts/test.ps1
$ErrorActionPreference = 'Stop'

# Under a Turkish system locale the JVM upper-cases "i" to a dotted capital I,
# which breaks Daml-LF name validation. Force an English JVM locale.
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'daml')
try {
    dpm build --all
    Push-Location 'orvane-test'
    try { dpm test } finally { Pop-Location }
} finally {
    Pop-Location
}

# TypeScript unit tests (quote engine against captured Cantex quotes)
Push-Location $root
try { node --test (Get-ChildItem shared -Filter *.test.ts).FullName } finally { Pop-Location }
