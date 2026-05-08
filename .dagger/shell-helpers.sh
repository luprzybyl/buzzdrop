# Dagger shell helpers - source this in your ~/.bashrc or ~/.zshrc
# Add to your shell profile: source ~/git/buzzdrop/.dagger/shell-helpers.sh

# Disable Dagger Cloud nag
export DAGGER_NO_NAG=1

# Dagger build mode switcher
dagger-mode() {
    case "$1" in
        local)
            unset _EXPERIMENTAL_DAGGER_RUNNER_HOST
            echo "✓ Dagger mode: LOCAL"
            ;;
        remote|vps)
            export _EXPERIMENTAL_DAGGER_RUNNER_HOST="tcp://10.10.0.1:8080"
            echo "✓ Dagger mode: REMOTE (10.10.0.1)"
            ;;
        status)
            if [ -n "$_EXPERIMENTAL_DAGGER_RUNNER_HOST" ]; then
                echo "Current mode: REMOTE ($_EXPERIMENTAL_DAGGER_RUNNER_HOST)"
            else
                echo "Current mode: LOCAL"
            fi
            ;;
        *)
            echo "Usage: dagger-mode [local|remote|status]"
            echo ""
            echo "  local   - Build on local machine"
            echo "  remote  - Build on VPS (10.10.0.1)"
            echo "  status  - Show current mode"
            ;;
    esac
}

# Quick aliases
alias dagger-local='dagger-mode local'
alias dagger-remote='dagger-mode remote'
alias dagger-status='dagger-mode status'

# Auto-detect and set based on VPN connectivity
dagger-auto() {
    if nc -z -w 1 10.10.0.1 8080 2>/dev/null; then
        dagger-mode remote
    else
        dagger-mode local
    fi
}
