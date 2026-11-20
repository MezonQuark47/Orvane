# Run the official CIP-0103 Wallet Gateway next to LocalNet, so wallets
# (external parties, keys held by the gateway) can use Orvane.
#
# Usage:  ./scripts/wallet-gateway.ps1 up | stop | logs
#         ./scripts/wallet-gateway.ps1 user <client-id>
#   up     start (or resume) the gateway on http://localhost:3030
#   stop   stop it, keeping its data
#   user   create the ledger user a wallet signs in as (Client ID in the
#          gateway's sign-in page; Client Secret on LocalNet is "unsafe")
#
# The gateway keeps its database, including the keys of the wallets you
# create, in .localnet/wallet-gateway (ignored by git). LocalNet test wallets
# only; never point this at a real network.
param(
  [ValidateSet('up', 'stop', 'logs', 'user')] [string]$Action = 'up',
  [string]$Name
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root '.localnet\wallet-gateway'
$image = 'ghcr.io/digital-asset/wallet-gateway/docker/wallet-gateway:v1.14.0'
$container = 'orvane-wallet-gateway'

switch ($Action) {
  'up' {
    New-Item -ItemType Directory -Force $data | Out-Null
    $config = Join-Path $data 'config.docker.json'
    if (-not (Test-Path $config)) { Copy-Item (Join-Path $PSScriptRoot 'wallet-gateway\config.json') $config }
    $exists = docker ps -a --filter "name=^$container$" --format '{{.Names}}'
    if ($exists) {
      docker start $container | Out-Null
    } else {
      docker run -d --name $container -p 3030:3030 -e LOCALNET_SECRET=unsafe `
        --add-host host.docker.internal:host-gateway `
        -v "${data}:/data" $image -c /data/config.docker.json | Out-Null
    }
    Write-Host "wallet gateway on http://localhost:3030"
  }
  'stop' { docker stop $container | Out-Null }
  'logs' { docker logs --tail 80 $container }
  'user' {
    if (-not $Name) { throw 'usage: ./scripts/wallet-gateway.ps1 user <client-id>' }
    node (Join-Path $PSScriptRoot 'gateway-user.ts') $Name
  }
}
