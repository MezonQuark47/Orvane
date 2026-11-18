# Start / stop the Splice LocalNet (a full local Canton Network with Canton Coin).
#
# Needs Docker Desktop and the official Splice node bundle, unpacked from
# https://github.com/digital-asset/decentralized-canton-sync/releases
# Point ORVANE_SPLICE_DIR at the bundle's "splice-node" folder.
#
# Usage:  ./scripts/localnet.ps1 up | stop | down | status | logs
#   up     start (or resume) LocalNet
#   stop   stop the containers but keep all ledger data, so `up` resumes it
#   down   stop and DELETE all LocalNet data
#
# Ports (127.0.0.1):
#   JSON Ledger API   app-provider :3975   app-user :2975   sv :4975
#   Wallet UI         app-provider http://wallet.localhost:3000
#                     app-user     http://wallet.localhost:2000
#   Scan UI           http://scan.localhost:4000
param([ValidateSet('up', 'stop', 'down', 'status', 'logs')] [string]$Action = 'up')
$ErrorActionPreference = 'Stop'

$splice = if ($env:ORVANE_SPLICE_DIR) { $env:ORVANE_SPLICE_DIR } else { Join-Path $HOME 'canton\splice-0.10.2\splice-node' }
$dir = Join-Path $splice 'docker-compose\localnet'
if (-not (Test-Path $dir)) { throw "LocalNet files not found at $dir. Set ORVANE_SPLICE_DIR." }

$env:IMAGE_TAG = if ($env:IMAGE_TAG) { $env:IMAGE_TAG } else { '0.10.2' }
$env:LOCALNET_DIR = $dir
$compose = @(
  '--env-file', "$dir\compose.env",
  '--env-file', "$dir\env\common.env",
  '-f', "$dir\compose.yaml",
  '-f', "$dir\resource-constraints.yaml",
  '--profile', 'sv', '--profile', 'app-provider', '--profile', 'app-user'
)

switch ($Action) {
  'up' { docker compose @compose up -d }
  'stop' { docker compose @compose stop }
  'down' { docker compose @compose down -v }
  'status' { docker compose @compose ps --format 'table {{.Name}}\t{{.Status}}' }
  'logs' { docker compose @compose logs --tail 80 }
}
