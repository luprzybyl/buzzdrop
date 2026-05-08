# Reusable Dagger Configuration

This `.dagger/` directory contains a **repo-agnostic** Dagger pipeline for Python projects.

## Features

✅ **Auto-detects** project name and owner from git remote  
✅ **Configurable** via `config.toml` (or uses sensible defaults)  
✅ **Works with any** Python web framework (Flask, Django, FastAPI)  
✅ **Per-project build counters** (separate for each repo)  
✅ **Multiple registry support** (GHCR, Docker Hub, GitLab)

## Quick Start

### 1. Copy to Your Project

```bash
# Copy the entire .dagger/ directory to your project
cp -r /path/to/buzzdrop/.dagger /path/to/your-project/

# Make scripts executable
chmod +x /path/to/your-project/.dagger/build.sh
```

### 2. Create config.toml (Optional)

If you want to customize, create `.dagger/config.toml`:

```toml
[project]
name = "my-app"           # Auto-detected if not set
owner = "myusername"      # Auto-detected from git remote

[python]
version = "3.12-alpine"
test_command = ["pytest", "-v"]

[docker]
port = 8000
entrypoint = ["uvicorn", "main:app", "--host", "0.0.0.0"]

[docker.env]
# Any environment variables your app needs
APP_ENV = "production"

[registry]
url = "ghcr.io"
token_env = "GITHUB_TOKEN"
```

If `config.toml` doesn't exist, it will auto-detect everything!

### 3. Run Builds

```bash
cd your-project
.dagger/build.sh local    # or remote, or auto
```

## Configuration Reference

### Auto-Detection

If `config.toml` is missing or incomplete, the pipeline auto-detects:

- **Project name**: From `git remote get-url origin` or current directory name
- **Owner**: From git remote URL (e.g., `github.com/owner/repo` → `owner`)
- **Python version**: Defaults to `3.12-alpine`
- **Test command**: Defaults to `pytest -v`

### config.toml Sections

#### [project]
```toml
[project]
name = "my-app"      # Image name: ghcr.io/owner/my-app
owner = "username"   # Your GitHub/GitLab username
```

#### [python]
```toml
[python]
version = "3.12-alpine"              # Or "3.11-slim", "3.10", etc.
test_command = ["pytest", "-v"]      # Or ["python", "-m", "unittest"]
```

#### [docker]
```toml
[docker]
port = 8000                          # Port to expose
entrypoint = ["python", "app.py"]    # How to start your app

[docker.env]
# Environment variables for runtime
APP_ENV = "production"
DATABASE_URL = "postgresql://..."

[docker.build_steps]
# Additional commands to run during build
commands = [
    ["mkdir", "-p", "uploads"],
    ["chmod", "+x", "entrypoint.sh"]
]
```

#### [registry]
```toml
[registry]
url = "ghcr.io"              # Or "docker.io", "registry.gitlab.com"
token_env = "GITHUB_TOKEN"   # Env var name for auth token
```

#### [exclude]
```toml
[exclude]
# Additional files/dirs to exclude from Docker context
patterns = [
    "uploads/",
    "data/",
    "*.db"
]
```

## Framework Examples

### Flask
```toml
[docker]
port = 5000
entrypoint = ["flask", "run"]

[docker.env]
FLASK_APP = "app.py"
FLASK_RUN_HOST = "0.0.0.0"
```

### Django
```toml
[docker]
port = 8000
entrypoint = ["python", "manage.py", "runserver", "0.0.0.0:8000"]

[docker.env]
DJANGO_SETTINGS_MODULE = "myproject.settings"
```

### FastAPI
```toml
[docker]
port = 8000
entrypoint = ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## Build Counter Per Project

Build numbers are stored per project in `~/.dagger/build-counters/{project-name}.txt`:

```bash
# buzzdrop: ~/.dagger/build-counters/buzzdrop.txt
# my-api:   ~/.dagger/build-counters/my-api.txt
# blog:     ~/.dagger/build-counters/blog.txt
```

Each project has independent daily counters.

## Registry Support

### GitHub Container Registry (GHCR)
```toml
[registry]
url = "ghcr.io"
token_env = "GITHUB_TOKEN"
```

Token scopes: `write:packages`, `read:packages`

### Docker Hub
```toml
[registry]
url = "docker.io"
token_env = "DOCKER_PASSWORD"
```

Also set: `export DOCKER_USERNAME="your-username"`

### GitLab Container Registry
```toml
[registry]
url = "registry.gitlab.com"
token_env = "GITLAB_TOKEN"
```

## Migration from Old main.py

If you're updating from the hardcoded version:

1. **Backup** your current `main.py`
2. **Replace** with `main.py.new` → `main.py`
3. **Create** `config.toml` with your settings (or rely on auto-detect)
4. **Test** with `.dagger/build.sh local`

## Dependencies

The generic pipeline needs one additional dependency for TOML parsing:

```bash
pip install tomli  # For Python < 3.11
# Or use Python 3.11+ which has tomllib built-in
```

Or add to your `requirements.txt`:
```
tomli; python_version < '3.11'
```

## Customization

For advanced customization, edit `main.py` directly. The code is well-commented and modular.

Common customizations:
- Add database migrations step
- Run additional linters (ruff, mypy)
- Multi-stage Docker builds
- Build both amd64 and arm64 images
