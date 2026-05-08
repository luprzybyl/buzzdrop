# Dagger CI/CD Configuration

This directory contains a reusable Dagger pipeline for Python projects with self-hosted remote execution support.

## 📁 Directory Structure

```
.dagger/
├── main.py                      # Main pipeline script (tests, build, publish)
├── config.toml                  # Project-specific configuration
├── build.sh                     # Wrapper script (local/remote/auto modes)
├── README.md                    # This file
├── SECRETS.md                   # Secret management guide
├── STEPS.md                     # Selective build steps reference
├── GHCR.md                      # GitHub Container Registry setup
└── REUSABLE.md                  # Guide for using in other projects
```

## 🚀 Quick Start

### Basic Usage

```bash
# Run full pipeline locally
.dagger/build.sh local

# Run full pipeline on VPS (via VPN)
.dagger/build.sh remote

# Auto-detect (VPS if available, else local)
.dagger/build.sh auto
```

### Selective Steps

```bash
# Only run tests (fast feedback)
.dagger/build.sh local --test

# Build without tests
.dagger/build.sh remote --skip-tests

# Build locally without publishing
.dagger/build.sh local --skip-publish
```

See [STEPS.md](STEPS.md) for all step combinations.

## 📚 Documentation

| File | Description |
|------|-------------|
| [README.md](README.md) | This overview (start here) |
| [SECRETS.md](SECRETS.md) | How secrets work and are managed |
| [STEPS.md](STEPS.md) | Selective build steps guide |
| [GHCR.md](GHCR.md) | GitHub Container Registry setup |
| [REUSABLE.md](REUSABLE.md) | Using this config in other projects |

## ⚙️ Configuration

### config.toml

Project-specific settings (optional - auto-detects if missing):

```toml
[project]
name = "buzzdrop"
owner = "luprzybyl"

[python]
version = "3.15-rc-alpine3.22"
test_command = ["pytest", "-v"]

[docker]
port = 5000
entrypoint = ["flask", "run"]

[registry]
url = "ghcr.io"
token_env = "GITHUB_TOKEN"
```

See [config.toml](config.toml) for full configuration options.

## 🔐 Secrets

Set `GITHUB_TOKEN` environment variable:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

For **remote builds from laptop**, secrets stay on your laptop and are sent encrypted to the VPS engine. See [SECRETS.md](SECRETS.md) for details.

## 🏷️ Image Tagging

Images are tagged as: `ghcr.io/owner/repo:YYYYMMDD-N`

- `YYYYMMDD` = Build date
- `N` = Build number for that day (1, 2, 3...)
- Counter resets daily

Examples:
- `ghcr.io/luprzybyl/buzzdrop:20260508-1`
- `ghcr.io/luprzybyl/buzzdrop:20260508-2`

## 🔄 Using in Other Projects

This configuration is designed to be portable. To use in another Python project:

```bash
# Copy the .dagger folder
cp -r ~/git/buzzdrop/.dagger ~/git/my-other-project/

# Optionally customize config.toml
# Or let it auto-detect everything!

cd ~/git/my-other-project
.dagger/build.sh local
```

See [REUSABLE.md](REUSABLE.md) for detailed instructions.

## 🎯 Features

- ✅ **Local or remote execution** - Build on laptop or VPS
- ✅ **Auto-detection** - Project name, owner, Python version
- ✅ **Selective steps** - Run only tests, build, or publish
- ✅ **Secure secrets** - Never logged or cached
- ✅ **Daily build counters** - Per-project versioning
- ✅ **Multiple registries** - GHCR, Docker Hub, GitLab
- ✅ **Framework agnostic** - Flask, Django, FastAPI, etc.

## 📖 Full Documentation

1. **Start here**: [README.md](README.md) ← You are here
2. **Setup secrets**: [SECRETS.md](SECRETS.md)
3. **Learn selective steps**: [STEPS.md](STEPS.md)
4. **Configure GHCR**: [GHCR.md](GHCR.md)
5. **Use in other projects**: [REUSABLE.md](REUSABLE.md)

## 🐛 Troubleshooting

**Cannot connect to remote engine:**
```bash
# Check VPS engine is running
ssh vps 'docker ps | grep dagger'

# Test connectivity
nc -zv 10.10.0.1 8080
```

**Tests failing:**
```bash
# Run tests only to debug
.dagger/build.sh local --test
```

**No GitHub token:**
```bash
# Check if set
echo $GITHUB_TOKEN

# Set temporarily
export GITHUB_TOKEN="ghp_xxx"

# Set permanently in ~/.bashrc
echo 'export GITHUB_TOKEN="ghp_xxx"' >> ~/.bashrc
```

## 🔧 Requirements

- **Dagger CLI** installed (`brew install dagger` or download from dagger.io)
- **Docker** or compatible container runtime
- **Python 3.11+** (for tomllib) or install `tomli` package
- **Git** repository (for auto-detection)

## 📝 Notes

- Build counters stored in `~/.dagger/build-counters/{project}.txt`
- Engine cache in VPS: `/var/lib/dagger` (persistent volume)
- Secrets never written to disk or logs
- VPN connection required for remote builds (10.10.0.1:8080)
