# Dagger Python CI/CD Pipeline

Universal CI/CD pipeline for Python projects: test → build → push to GHCR.

## How It Works

**Local mode:** Dagger runs on your laptop using Docker.

**Remote mode:** Dagger connects to a remote engine on your VPS (via VPN at `10.10.0.1:8080`). The engine only runs containers - no config files, no secrets stored there.

```bash
# Local build
.dagger/build.sh local

# Remote build (connects to VPS engine)
export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://10.10.0.1:8080
.dagger/build.sh remote
```

## Secrets

Secrets live on your laptop, not on VPS:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

When running remote builds from laptop, secrets are sent **encrypted** to the VPS engine for that build only. Never stored on VPS disk.

## Pipeline Steps

1. **Test** - Run pytest in container
2. **Build** - Create Docker image
3. **Push** - Publish to `ghcr.io/owner/repo:YYYYMMDD-N`

Run selectively:
```bash
.dagger/build.sh local --test         # Only tests
.dagger/build.sh remote --skip-tests  # Build + push only
```

## Setup in New Project

This config is managed via git subtree for easy syncing across projects.

**First time:**
```bash
cd your-project
git subtree add --prefix .dagger \
  https://github.com/luprzybyl/dagger-python-template.git main --squash
```

**Update later:**
```bash
git subtree pull --prefix .dagger \
  https://github.com/luprzybyl/dagger-python-template.git main --squash
```

**Customize:**
Edit `.dagger/config.toml` for project-specific settings (Python version, ports, etc.). This file stays in your project repo, not the template.

## VPS Engine Setup

**On VPS** (one-time):
```bash
docker run -d --name dagger-engine --privileged \
  -v dagger-cache:/var/lib/dagger \
  -p 10.10.0.1:8080:8080 \
  --restart unless-stopped \
  registry.dagger.io/engine:latest
```

**Access via socat** (if engine only listens on Unix socket):
```bash
docker run -d --name dagger-tcp-proxy \
  --volumes-from dagger-engine \
  -p 10.10.0.1:8080:8080 \
  alpine/socat:latest \
  TCP-LISTEN:8080,fork,reuseaddr UNIX-CONNECT:/var/run/dagger/engine.sock
```

## Requirements

- Dagger CLI installed
- Docker (or compatible runtime)
- `config.toml` with project settings (or relies on auto-detection)
- GITHUB_TOKEN env var for publishing

## Files

```
.dagger/
├── main.py        # Pipeline implementation
├── build.sh       # Wrapper script
└── config.toml    # Project settings (customize per-project)
```

Build counters stored in `~/.dagger/build-counters/{project}.txt`, reset daily.
