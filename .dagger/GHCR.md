# GitHub Container Registry Publishing

The Dagger pipeline publishes Docker images to GitHub Container Registry (GHCR).

## Image Tag Format

Images are tagged as: `ghcr.io/luprzybyl/buzzdrop:YYYYMMDD-N`

Where:
- `YYYYMMDD` is the current date
- `N` is the build number for that day (starts at 1, increments per build)

Examples:
- `ghcr.io/luprzybyl/buzzdrop:20260508-1` (first build on May 8, 2026)
- `ghcr.io/luprzybyl/buzzdrop:20260508-2` (second build same day)
- `ghcr.io/luprzybyl/buzzdrop:20260509-1` (first build next day, counter resets)

## Setup

### 1. Create GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name: "Dagger GHCR Push"
4. Select scopes:
   - ✅ `write:packages` (required for pushing)
   - ✅ `read:packages` (recommended)
   - ✅ `delete:packages` (optional, for cleanup)
5. Click "Generate token"
6. **Copy the token** (you won't see it again!)

### 2. Set Environment Variable

**For local builds:**
```bash
# Add to ~/.bashrc or ~/.zshrc
export GITHUB_TOKEN="ghp_your_token_here"
```

**For remote VPS builds:**
```bash
# SSH to VPS and add to your shell profile
ssh mikrus
echo 'export GITHUB_TOKEN="ghp_your_token_here"' >> ~/.bashrc
source ~/.bashrc
```

Or add it to your docker-compose environment (less secure):
```yaml
dagger-engine:
  environment:
    - GITHUB_TOKEN=ghp_your_token_here
```

### 3. Test Publishing

```bash
# Local
.dagger/build.sh local

# Remote
.dagger/build.sh remote
```

If `GITHUB_TOKEN` is set, images will publish to GHCR.
If not set, the build will complete but skip publishing with a warning.

## Build Counter

The build counter is stored in `~/.dagger/build-counter.txt`:
- Format: `YYYYMMDD:N`
- Resets to 1 each day
- Separate counters for local and VPS builds

To reset the counter manually:
```bash
# Local
rm ~/.dagger/build-counter.txt

# VPS
ssh mikrus "rm ~/.dagger/build-counter.txt"
```

## Viewing Published Images

Visit: https://github.com/luprzybyl?tab=packages

Or pull an image:
```bash
docker pull ghcr.io/luprzybyl/buzzdrop:20260508-1
```

## Making Images Public

By default, GHCR images are private. To make them public:

1. Go to https://github.com/luprzybyl?tab=packages
2. Click on the `buzzdrop` package
3. Click "Package settings" (right sidebar)
4. Scroll to "Danger Zone"
5. Click "Change visibility" → "Public"
