# .dagger/ Directory Index

Quick navigation for all documentation files.

## 📖 Documentation Files

| File | Purpose | When to Read |
|------|---------|--------------|
| **README.md** | Overview and quick start | **Start here** - First time setup |
| **SECRETS.md** | Secret management guide | Setting up GitHub token and understanding security |
| **STEPS.md** | Selective build steps | Learning how to run specific pipeline steps |
| **GHCR.md** | GitHub Container Registry | Setting up image publishing |
| **REUSABLE.md** | Multi-project usage | Copying this config to other projects |

## 🔧 Configuration Files

| File | Purpose |
|------|---------|
| **config.toml** | Project settings (Python version, ports, etc.) |

## 🚀 Executable Scripts

| File | Purpose |
|------|---------|
| **build.sh** | Main build wrapper (local/remote/auto modes) |

## 💻 Core Pipeline

| File | Purpose |
|------|---------|
| **main.py** | Dagger pipeline (tests, build, publish) |

## 📝 Reading Order (First Time)

1. **README.md** - Get overview and basic usage
2. **SECRETS.md** - Set up GitHub token for publishing
3. **STEPS.md** - Learn selective build options
4. Run your first build: `.dagger/build.sh local --test`
5. **GHCR.md** - (Optional) If you need registry details
6. **REUSABLE.md** - (Optional) When copying to other projects

## 🎯 Quick Lookup

### "How do I..."

- **Run only tests?** → `build.sh local --test` (see STEPS.md)
- **Set up secrets?** → SECRETS.md
- **Build on VPS?** → `build.sh remote` (README.md)
- **Configure Python version?** → config.toml
- **Use in another project?** → REUSABLE.md
- **Understand image tags?** → GHCR.md or README.md

### "What does..."

- **build.sh do?** → Wrapper that routes to local/remote engine
- **main.py do?** → Actual pipeline (test → build → publish)
- **config.toml do?** → Project-specific settings
- **DAGGER_NO_NAG do?** → Disables Dagger Cloud promotion
- **GITHUB_TOKEN do?** → Authenticates for image publishing

## 📏 File Sizes

- **Total documentation**: ~800 lines / ~25 KB
- **Core code**: ~300 lines (main.py + build.sh)
- **Configuration**: ~50 lines (config.toml)

## 🗂️ By Topic

### Setup & Getting Started
- README.md
- SECRETS.md

### Usage & Operations
- STEPS.md
- build.sh

### Advanced Topics
- REUSABLE.md
- GHCR.md

### Configuration
- config.toml
