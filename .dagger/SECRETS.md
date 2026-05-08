# Secret Management in Dagger

This document explains how secrets (like GitHub tokens) are handled in the Buzzdrop Dagger pipeline.

## How Dagger Secrets Work

Dagger has built-in safeguards to ensure secrets are never leaked:

- ✅ **Never logged** to terminal output or build logs
- ✅ **Never cached** in build layers
- ✅ **Never written** to container filesystems (unless you explicitly do so)
- ✅ **Encrypted in transit** between client and engine
- ✅ **Opaque references** - only IDs are passed around, not actual values

## Secret Flow

```
Your Environment → Python Script → Encrypted → Dagger Engine → Registry
   (reads here)                     (over wire)   (uses secret)
```

The secret is read **where you run the `dagger` command**, not in the engine container.

## Setup

### Required Secret: GitHub Token

To publish Docker images to GitHub Container Registry, you need a Personal Access Token.

**Create token:**
1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Name: "Dagger GHCR Push"
4. Scopes needed:
   - ✅ `write:packages` (required)
   - ✅ `read:packages` (recommended)
5. Copy the token (you won't see it again!)

**Set environment variable:**

```bash
# Add to ~/.bashrc or ~/.zshrc for persistence
echo 'export GITHUB_TOKEN="ghp_your_token_here"' >> ~/.bashrc
source ~/.bashrc

# Or set temporarily for one session
export GITHUB_TOKEN="ghp_your_token_here"
```

**Verify it's set:**
```bash
echo $GITHUB_TOKEN
# Should print: ghp_your_token_here
```

## Build Scenarios

### 1. Local Build (Laptop)

```bash
# Secrets read from laptop environment
export GITHUB_TOKEN="ghp_xxx"
.dagger/build.sh local
```

**Flow:**
- Python script runs on **laptop**
- Reads `GITHUB_TOKEN` from **laptop** environment
- Dagger engine runs on **laptop**
- Secret never leaves your machine

### 2. Remote Build from Laptop (VPN)

```bash
# Secrets still read from laptop!
export GITHUB_TOKEN="ghp_xxx"
.dagger/build.sh remote
```

**Flow:**
- Python script runs on **laptop**
- Reads `GITHUB_TOKEN` from **laptop** environment
- Secret sent **encrypted** to VPS engine over VPN
- VPS engine builds and publishes
- **VPS never stores the secret** ✅

**Benefits:**
- 🔒 Secrets stay on your laptop
- ☁️ VPS does heavy computation
- 🚂 Perfect for train scenario - secrets are secure even on bad connection

### 3. Remote Build from VPS (SSH)

```bash
# SSH to VPS first
ssh mikrus
export GITHUB_TOKEN="ghp_xxx"
dagger run python .dagger/main.py
```

**Flow:**
- Python script runs on **VPS**
- Reads `GITHUB_TOKEN` from **VPS** environment
- VPS engine runs locally on VPS
- Secret stays within VPS

**When to use:**
- Setting up automated builds/CI on VPS
- Running scheduled builds without your laptop

**Setup on VPS:**
```bash
ssh mikrus
echo 'export GITHUB_TOKEN="ghp_xxx"' >> ~/.bashrc
source ~/.bashrc
```

## Security Best Practices

### ✅ Do:
- Store tokens in environment variables
- Use separate tokens per machine/purpose
- Rotate tokens periodically
- Use minimal required scopes
- Keep `.env` files in `.gitignore`

### ❌ Don't:
- Commit tokens to git
- Print tokens in scripts (`echo $GITHUB_TOKEN`)
- Store tokens in plain text files in project directory
- Use tokens with more permissions than needed
- Share tokens between team members

## Alternative Secret Storage

### File-based (more secure on VPS)

```bash
# Store in dedicated secrets directory
mkdir -p ~/.secrets
chmod 700 ~/.secrets
echo "ghp_your_token" > ~/.secrets/github-token
chmod 600 ~/.secrets/github-token
```

Then update `main.py` to read from file:
```python
from pathlib import Path

github_token_file = Path.home() / ".secrets" / "github-token"
if github_token_file.exists():
    github_token = github_token_file.read_text().strip()
else:
    github_token = os.getenv("GITHUB_TOKEN")  # Fallback
```

### Supported Secret Providers

Dagger supports multiple secret providers (not yet implemented in our pipeline):

- `env:` - Environment variables (current)
- `file:` - Read from file
- `cmd:` - Command output (e.g., `pass show token`)
- `vault:` - HashiCorp Vault
- `op:` - 1Password CLI
- `aws+sm:` - AWS Secrets Manager
- `aws+ps:` - AWS Parameter Store

## Troubleshooting

### "GITHUB_TOKEN not set" warning

**Symptom:**
```
⚠️  GITHUB_TOKEN not set - skipping publish to GHCR
```

**Solution:**
```bash
# Check if token is set
echo $GITHUB_TOKEN

# If empty, set it
export GITHUB_TOKEN="ghp_your_token_here"

# For persistence, add to shell profile
echo 'export GITHUB_TOKEN="ghp_xxx"' >> ~/.bashrc
source ~/.bashrc
```

### "Permission denied" during publish

**Symptom:**
```
Error: failed to push: insufficient_scope
```

**Solution:**
- Token needs `write:packages` scope
- Regenerate token with correct permissions
- Update `GITHUB_TOKEN` environment variable

### Secret visible in logs

**This should never happen!** If you see your token in logs:
- Do NOT commit those logs
- Regenerate your token immediately
- Report issue (shouldn't happen with Dagger's safeguards)

## What Gets Logged vs. What Stays Secret

### ✅ Safe to share/commit:
- Pipeline code (`main.py`)
- Build output and test results
- Image names and tags (e.g., `ghcr.io/luprzybyl/buzzdrop:20260508-1`)
- Build logs (tests passing/failing)

### 🔒 Never logged:
- Token values (`ghp_xxx`)
- Secret content
- Credentials in any form

## FAQ

**Q: Do I need to set GITHUB_TOKEN on the VPS for remote builds from laptop?**  
A: No! When running `.dagger/build.sh remote` from your laptop, secrets are read from your laptop and sent encrypted to the VPS engine.

**Q: Where is the secret stored during builds?**  
A: Only in memory of the Dagger engine process. Never written to disk.

**Q: Can I use different tokens for laptop vs VPS?**  
A: Yes! Each environment can have its own token. Useful for tracking which builds came from where.

**Q: What if I lose connection during a remote build?**  
A: The build continues on the VPS! However, if your laptop provided the secret, the build will complete with that secret already in the engine's memory.

**Q: Is the VPN connection encrypted?**  
A: Yes, WireGuard VPN provides encryption. Additionally, Dagger encrypts secrets in transit over the connection.
