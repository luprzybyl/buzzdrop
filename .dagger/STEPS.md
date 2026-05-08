# Selective Build Steps - Quick Reference

## Usage Examples

### Full Pipeline (Default)
```bash
.dagger/build.sh local          # Test + Build + Publish
.dagger/build.sh remote         # All steps on VPS
```

### Only Tests (Fast Feedback)
```bash
.dagger/build.sh local --test   # Only run tests
# Output: 🧪 Running tests... ✓ Tests passed!
# Time: ~1-2 minutes vs 5-10 minutes full build
```

### Only Build (No Tests, No Publish)
```bash
.dagger/build.sh local --build  # Build image only
# Output: 🐋 Building Docker image... ✓ Docker image built!
# Useful for: Testing Dockerfile changes locally
```

### Build + Publish (Skip Tests)
```bash
.dagger/build.sh remote --skip-tests
# Output: 🐋 Building... ✓ Built! 📦 Publishing... ✓ Published!
# Useful for: When tests already passed in CI
```

### Test + Build (No Publish)
```bash
.dagger/build.sh local --skip-publish
# Output: 🧪 Testing... ✓ Tests passed! 🐋 Building... ✓ Built!
# Useful for: Local development without pushing
```

## Flags

| Flag | Effect |
|------|--------|
| `--test` | Run tests only (skip build & publish) |
| `--build` | Build image only (skip tests & publish) |
| `--publish` | Build and publish (includes build step) |
| `--skip-tests` | Skip testing (build & publish) |
| `--skip-publish` | Skip publishing (test & build only) |

## Common Workflows

### 🏠 At Home (Fast Laptop)
```bash
# Quick test locally
.dagger/build.sh local --test

# Build and test locally, publish from VPS
.dagger/build.sh local --skip-publish  # First
.dagger/build.sh remote --publish      # Then
```

### 🚂 On Train (Bad Connection)
```bash
# Run heavy tests on VPS
.dagger/build.sh remote --test

# Full build on VPS
.dagger/build.sh remote
```

### 🔧 Debugging Build
```bash
# Test build locally without publishing
.dagger/build.sh local --skip-publish

# If build works, publish
.dagger/build.sh local --publish
```

### ⚡ CI/CD Pipeline
```bash
# Job 1: Tests
.dagger/build.sh remote --test

# Job 2: Build & Publish (if tests pass)
.dagger/build.sh remote --skip-tests
```

## Output Indicators

- 🧪 = Running tests
- 🐋 = Building Docker image
- 📦 = Publishing to registry
- ✓ = Step completed successfully
- ⚠️ = Warning (e.g., no GitHub token)
- ❌ = Error

## Pro Tips

1. **Use `--test` first** for quick feedback (1-2 min)
2. **Skip tests after CI** passes with `--skip-tests`
3. **Test builds locally** with `--skip-publish` before pushing
4. **Combine with auto mode** for smart routing:
   ```bash
   .dagger/build.sh auto --test  # VPS if connected, laptop if not
   ```
