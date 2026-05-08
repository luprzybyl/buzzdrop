#!/usr/bin/env bash
# Dagger build wrapper - easily switch between local and remote builds

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# VPS engine address
VPS_ENGINE="tcp://10.10.0.1:8080"

show_help() {
    cat << EOF
Usage: ./build.sh [MODE] [OPTIONS]

Run Dagger pipeline locally or remotely on VPS.

Modes:
  local     Build on local machine (default)
  remote    Build on VPS (10.10.0.1)
  auto      Automatically detect (VPN connected = remote, otherwise local)

Options:
  --test           Run tests only
  --build          Build Docker image only
  --publish        Build and publish to registry
  --skip-tests     Skip running tests
  --skip-publish   Skip publishing to registry

Examples:
  ./build.sh                      # Full build locally
  ./build.sh remote               # Full build on VPS
  ./build.sh local --test         # Only run tests locally
  ./build.sh remote --skip-tests  # Build and publish on VPS, skip tests
  ./build.sh auto --build         # Build only (auto-detect where)

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
    dagger run python .dagger/main.py "$@"
}

run_remote() {
    echo -e "${BLUE}☁️  Running build on VPS (10.10.0.1)...${NC}"
    export _EXPERIMENTAL_DAGGER_RUNNER_HOST="$VPS_ENGINE"
    export DAGGER_NO_NAG=1
    dagger run python .dagger/main.py "$@"
}

run_auto() {
    if check_vpn; then
        echo -e "${BLUE}✓ VPN detected - using remote VPS build${NC}"
        run_remote "$@"
    else
        echo -e "${GREEN}✗ VPN not available - using local build${NC}"
        run_local "$@"
    fi
}

# Parse mode (first argument)
MODE="${1:-local}"

# Check if it's a help flag or option flag
if [[ "$MODE" == "-h" ]] || [[ "$MODE" == "--help" ]] || [[ "$MODE" == "help" ]]; then
    show_help
    exit 0
fi

# Check if first arg is an option (starts with --)
if [[ "$MODE" == --* ]]; then
    # No mode specified, default to local, and treat first arg as option
    MODE="local"
else
    # Mode was specified, shift it off
    shift
fi

# All remaining arguments are options to pass to main.py
OPTIONS="$@"

case "$MODE" in
    local)
        run_local $OPTIONS
        ;;
    remote)
        run_remote $OPTIONS
        ;;
    auto)
        run_auto $OPTIONS
        ;;
    *)
        echo "Unknown mode: $MODE"
        echo ""
        show_help
        exit 1
        ;;
esac
