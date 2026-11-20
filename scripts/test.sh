#!/usr/bin/env bash
# Build all Daml packages, run the Daml Script suite and the TypeScript unit tests.
# Usage (from repo root):  ./scripts/test.sh
set -euo pipefail
export JAVA_TOOL_OPTIONS="-Duser.language=en -Duser.country=US"
cd "$(dirname "$0")/../daml"
dpm build --all
cd orvane-test
dpm test

# TypeScript unit tests (quote engine against captured Cantex quotes)
cd ..
node --test shared/*.test.ts
