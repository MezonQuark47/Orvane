# Build all Daml packages, run the Daml Script suite and the TypeScript unit tests.
# Usage (from repo root):  ./scripts/test.ps1
$ErrorActionPreference = 'Stop'

# Under a Turkish system locale the JVM upper-cases "i" to a dotted capital I,
# which breaks Daml-LF name validation. Force an English JVM locale.
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'

# Runs a native tool and fails on its exit code. dpm logs progress on stderr,
# and once output is redirected Windows PowerShell 5.1 turns each stderr line
# into an error, which 'Stop' would treat as a failure. So stderr is passed
# through as plain text and only the exit code decides.
function Invoke-Tool([string]$what, [scriptblock]$run) {
    $ErrorActionPreference = 'Continue'
    & $run 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$what failed with exit code $LASTEXITCODE" }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'daml')
try {
    Invoke-Tool 'dpm build' { dpm build --all }
    Push-Location 'orvane-test'
    try { Invoke-Tool 'dpm test' { dpm test } } finally { Pop-Location }
} finally {
    Pop-Location
}

# TypeScript unit tests (quote engine, proxy wrapper, swap settling)
Push-Location $root
try {
    $tests = (Get-ChildItem shared -Filter *.test.ts).FullName
    Invoke-Tool 'node --test' { node --test $tests }
} finally { Pop-Location }
