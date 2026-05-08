#!/usr/bin/env bash
# Sync .dagger/ configuration from template repo
#
# Usage:
#   ./sync-dagger.sh          # Update from main branch
#   ./sync-dagger.sh v1.2.3   # Update from specific tag

set -e

TEMPLATE_REPO="https://github.com/luprzybyl/dagger-python-template.git"
BRANCH="${1:-main}"
TEMP_DIR=$(mktemp -d)

echo "🔄 Syncing .dagger/ from template (${BRANCH})..."

# Clone template repo
git clone --depth 1 --branch "$BRANCH" "$TEMPLATE_REPO" "$TEMP_DIR" 2>/dev/null

# Backup current config if it exists
if [ -f ".dagger/config.toml" ]; then
    echo "💾 Backing up config.toml..."
    cp .dagger/config.toml .dagger/config.toml.backup
fi

# Copy .dagger/ (except config.toml)
echo "📦 Copying files..."
rsync -av --exclude='config.toml' --exclude='.git' "$TEMP_DIR/.dagger/" .dagger/

# Restore config
if [ -f ".dagger/config.toml.backup" ]; then
    mv .dagger/config.toml.backup .dagger/config.toml
    echo "✅ Restored your config.toml"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo "✅ Sync complete!"
echo ""
echo "Review changes with: git diff .dagger/"
echo "Commit if satisfied: git add .dagger/ && git commit -m 'Update Dagger config'"
