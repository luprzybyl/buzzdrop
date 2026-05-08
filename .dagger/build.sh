#!/usr/bin/env bash
# Dagger build wrapper - easily switch between local and remote builds

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# VPS engine address
VPS_ENGINE="tcp://10.10.0.1:8080"

show_help() {
    cat << EOF
Usage: ./build.sh [MODE]

Run Dagger pipeline locally or remotely on VPS.

Modes:
  local     Build on local machine (default)
  remote    Build on VPS (10.10.0.1)
  auto      Automatically detect (VPN connected = remote, otherwise local)

Examples:
  ./build.sh           # local build
  ./build.sh local     # local build
  ./build.sh remote    # VPS build
  ./build.sh auto      # auto-detect based on VPN

EOF
}

check_vpn() {
    # Check if VPS is reachable
    nc -z -w 1 10.10.0.1 8080 2>/dev/null
    return $?
}

run_local() {
    echo -e "${GREEN}🏠 Running build locally...${NC}"
    unset _EXPERIMENTAL_DAGGER_RUNNER_HOST
    export DAGGER_NO_NAG=1
    dagger run python .dagger/main.py
}

run_remote() {
    echo -e "${BLUE}☁️  Running build on VPS (10.10.0.1)...${NC}"
    export _EXPERIMENTAL_DAGGER_RUNNER_HOST="$VPS_ENGINE"
    export DAGGER_NO_NAG=1
    dagger run python .dagger/main.py
}

run_auto() {
    if check_vpn; then
        echo -e "${BLUE}✓ VPN detected - using remote VPS build${NC}"
        run_remote
    else
        echo -e "${GREEN}✗ VPN not available - using local build${NC}"
        run_local
    fi
}

# Parse arguments
MODE="${1:-local}"

case "$MODE" in
    local)
        run_local
        ;;
    remote)
        run_remote
        ;;
    auto)
        run_auto
        ;;
    -h|--help|help)
        show_help
        ;;
    *)
        echo "Unknown mode: $MODE"
        echo ""
        show_help
        exit 1
        ;;
esac
