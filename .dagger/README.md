# Dagger Pipeline Setup

## Quick Start

### Using the build script (recommended)

```bash
# Local build (on your laptop)
.dagger/build.sh local

# Remote build (on VPS)
.dagger/build.sh remote

# Auto-detect (uses VPS if VPN is connected)
.dagger/build.sh auto
```

### Using shell helpers (alternative)

Add to your `~/.bashrc` or `~/.zshrc`:
```bash
source ~/git/buzzdrop/.dagger/shell-helpers.sh
```

Then use:
```bash
dagger-local    # Switch to local mode
dagger-remote   # Switch to remote mode
dagger-auto     # Auto-detect and switch
dagger-status   # Show current mode

# Then run builds normally
dagger run python .dagger/main.py
```

### Manual execution

Run the pipeline locally (uses local Docker):

```bash
dagger run python .dagger/main.py
```

## Remote Execution on VPS

### 1. Setup Dagger Engine on VPS

Deploy the Dagger engine container on your VPS (10.10.0.1):

```bash
# On VPS - using the provided docker-compose config
docker-compose -f .dagger/docker-compose.engine.yml up -d

# Verify it's running
docker ps | grep dagger-engine
docker logs dagger-engine
```

### 2. Connect from Laptop

Set the environment variable to point to your VPS engine:

```bash
# On your laptop (connected to VPN)
export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://10.10.0.1:8080

# Run the pipeline - it executes on VPS!
dagger run python .dagger/main.py
```

**Benefits:**
- Pipeline runs on VPS hardware
- Can disconnect during build (it continues on VPS)
- Persistent cache on VPS speeds up subsequent builds
- All traffic over VPN (secure)

### 3. Optional: Add to your shell profile

Add to `~/.bashrc` or `~/.zshrc` for automatic VPS execution:

```bash
# Use VPS Dagger engine by default when on VPN
export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://10.10.0.1:8080
```

### 4. Check build status

Since builds continue running on VPS even after disconnecting:

```bash
# On VPS - check running containers
docker ps | grep -E 'dagger|buildkit'

# View Dagger engine logs
docker logs -f dagger-engine

# Check recent builds in cache
docker exec dagger-engine du -sh /var/lib/dagger
```

## Pipeline Stages

The pipeline in `main.py` performs:

1. **Test** - Runs pytest in Python container
2. **Build** - Creates production Docker image
3. **Publish** - Pushes to registry (currently ttl.sh)

## Customization

### Change Registry

Edit `main.py` line ~63 to use your registry:

```python
# Replace ttl.sh with your registry
image_name = "your-registry.com/buzzdrop:latest"

# Add authentication if needed
image_ref = await docker_image.with_registry_auth(
    "your-registry.com",
    "username",
    client.set_secret("registry-password", "your-password")
).publish(image_name)
```

### Adjust Python Version

Edit line 28 in `main.py` to change Python version:

```python
python_version = "3.13-alpine"  # or any other version
```

## Troubleshooting

**Connection refused:**
```bash
# Check if engine is running on VPS
ssh vps-user@10.10.0.1 'docker ps | grep dagger-engine'

# Check if port is accessible from laptop
nc -zv 10.10.0.1 8080
```

**Slow builds:**
- Ensure VPS has sufficient resources
- Check cache volume: `docker volume inspect dagger-engine-cache`
- Verify `/var/lib/dagger` is mounted correctly

**Version mismatch:**
```bash
# Check CLI version
dagger version

# Use matching engine version on VPS
# Edit docker-compose.engine.yml to use specific tag:
# image: registry.dagger.io/engine:v0.14.0
```
