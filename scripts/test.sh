#!/usr/bin/env bash
# Build all Daml packages and run the Daml Script test suite.
# Usage (from repo root):  ./scripts/test.sh
set -euo pipefail
export JAVA_TOOL_OPTIONS="-Duser.language=en -Duser.country=US"
cd "$(dirname "$0")/../daml"
dpm build --all
cd orvane-test
dpm test
