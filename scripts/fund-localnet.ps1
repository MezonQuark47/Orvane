# Developer-only: send LocalNet test funds (CC and the TestUSD test token) to
# a party, as transfer offers it accepts in Orvane (Portfolio > Incoming).
#
# Usage:  ./scripts/fund-localnet.ps1 -Party <party-id> [-Usd 1000] [-Cc 5000]
param(
  [Parameter(Mandatory = $true)] [string]$Party,
  [double]$Usd = 1000,
  [double]$Cc = 5000
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:ORVANE_NETWORK = 'localnet'
node (Join-Path $root 'operator/fund.ts') $Party --usd $Usd --cc $Cc
