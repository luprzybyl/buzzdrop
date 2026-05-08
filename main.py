#!/usr/bin/env python3
"""
Generic Dagger pipeline for Python projects
Reads configuration from config.toml and auto-detects project settings

Usage:
    python main.py                    # Run all steps
    python main.py --test             # Only run tests
    python main.py --build            # Only build image (no publish)
    python main.py --publish          # Build and publish
    python main.py --skip-tests       # Skip tests
    python main.py --skip-publish     # Skip publishing
"""
import argparse
import os
import sys
import subprocess
from datetime import datetime
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:
    import tomli as tomllib  # Fallback for older Python

import dagger


def load_config():
    """Load configuration from config.toml"""
    config_file = Path(__file__).parent / "config.toml"
    
    if config_file.exists():
        with open(config_file, "rb") as f:
            config = tomllib.load(f)
    else:
        # Default configuration if config.toml doesn't exist
        config = {
            "project": {"name": None, "owner": None},
            "python": {"version": "3.12-alpine", "test_command": ["pytest", "-v"]},
            "docker": {"port": 8000, "entrypoint": ["python", "app.py"], "env": {}},
            "registry": {"url": "ghcr.io", "token_env": "GITHUB_TOKEN"},
            "exclude": {"patterns": []},
        }
    
    # Auto-detect project name from git remote if not set
    if not config["project"].get("name"):
        try:
            remote = subprocess.check_output(
                ["git", "remote", "get-url", "origin"],
                cwd=Path(__file__).parent.parent,
                text=True,
            ).strip()
            # Extract repo name from git URL
            # https://github.com/user/repo.git -> repo
            # git@github.com:user/repo.git -> repo
            repo_name = remote.split("/")[-1].replace(".git", "")
            config["project"]["name"] = repo_name
        except Exception:
            config["project"]["name"] = Path.cwd().name
    
    # Auto-detect owner from git remote if not set
    if not config["project"].get("owner"):
        try:
            remote = subprocess.check_output(
                ["git", "remote", "get-url", "origin"],
                cwd=Path(__file__).parent.parent,
                text=True,
            ).strip()
            # Extract owner from git URL
            if "github.com" in remote:
                # https://github.com/user/repo.git -> user
                # git@github.com:user/repo.git -> user
                owner = remote.split("/")[-2].split(":")[-1]
                config["project"]["owner"] = owner
        except Exception:
            config["project"]["owner"] = "unknown"
    
    return config


async def main():
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Dagger build pipeline")
    parser.add_argument("--test", action="store_true", help="Run tests only")
    parser.add_argument("--build", action="store_true", help="Build image only (no publish)")
    parser.add_argument("--publish", action="store_true", help="Build and publish image")
    parser.add_argument("--skip-tests", action="store_true", help="Skip tests")
    parser.add_argument("--skip-publish", action="store_true", help="Skip publishing")
    args = parser.parse_args()
    
    # Determine which steps to run
    # If no flags specified, run all steps
    if not (args.test or args.build or args.publish):
        run_test = not args.skip_tests
        run_build = True
        run_publish = not args.skip_publish
    else:
        run_test = args.test
        run_build = args.build or args.publish  # Need to build for publish
        run_publish = args.publish
    
    cfg = load_config()
    config = dagger.Config(log_output=sys.stderr)
    
    async with dagger.Connection(config) as client:
        # Default excludes for Python projects
        default_excludes = [
            ".venv/", "venv/", ".env", "*.pyc",
            ".git/", ".pytest_cache/", "__pycache__/",
            ".dagger/", "sdk/",
        ]
        
        # Add project-specific excludes
        excludes = default_excludes + cfg.get("exclude", {}).get("patterns", [])
        
        # Get the source code directory
        source = client.host().directory(".", exclude=excludes)
        
        python_version = cfg["python"]["version"]
        test_command = cfg["python"].get("test_command", ["pytest", "-v"])
        docker_image = None
        
        # STEP 1: Run Tests
        if run_test:
            print(f"🧪 Running tests with Python {python_version}...")
            test_container = (
                client.container()
                .from_(f"python:{python_version}")
                .with_workdir("/app")
                .with_directory("/app", source)
                .with_exec(["pip", "install", "--no-cache-dir", "-r", "requirements.txt"])
            )
            
            test_result = await test_container.with_exec(test_command).stdout()
            print(test_result)
            print("✓ Tests passed!\n")
        
        # STEP 2: Build Docker Image
        if run_build:
            print("🐋 Building Docker image...")
            docker_image = (
                client.container()
                .from_(f"python:{python_version}")
                .with_env_variable("PYTHONDONTWRITEBYTECODE", "1")
                .with_env_variable("PYTHONUNBUFFERED", "1")
                .with_workdir("/app")
                .with_file("/app/requirements.txt", source.file("requirements.txt"))
                .with_exec(["pip", "install", "--no-cache-dir", "-r", "requirements.txt"])
                .with_directory("/app", source)
            )
            
            # Apply custom build steps
            for cmd in cfg.get("docker", {}).get("build_steps", {}).get("commands", []):
                docker_image = docker_image.with_exec(cmd)
            
            # Set environment variables from config
            for key, value in cfg.get("docker", {}).get("env", {}).items():
                docker_image = docker_image.with_env_variable(key, value)
            
            # Set port and entrypoint
            port = cfg.get("docker", {}).get("port", 8000)
            entrypoint = cfg.get("docker", {}).get("entrypoint", ["python", "app.py"])
            
            docker_image = (
                docker_image
                .with_exposed_port(port)
                .with_entrypoint(entrypoint)
            )
            print("✓ Docker image built!\n")
        
        # STEP 3: Publish to Registry
        image_ref = None
        if run_publish:
            if not docker_image:
                print("❌ Cannot publish without building first.")
                return None
            
            # Get build versioning info
        repo_name = cfg["project"]["name"]
        owner = cfg["project"]["owner"]
        build_date = datetime.now().strftime("%Y%m%d")
        build_number = get_next_build_number(build_date, repo_name)
        image_tag = f"{build_date}-{build_number}"
        
        # Publish to registry
        registry_url = cfg["registry"]["url"]
        token_env = cfg["registry"]["token_env"]
        token = os.getenv(token_env)
        
        if token:
            image_name = f"{registry_url}/{owner}/{repo_name}:{image_tag}"
            print(f"📦 Publishing image to {image_name}...")
            
            # Determine registry username based on registry type
            if "ghcr.io" in registry_url:
                username = owner
            elif "docker.io" in registry_url:
                username = owner
            elif "gitlab" in registry_url:
                username = owner
            else:
                username = owner
            
            image_ref = await (
                docker_image
                .with_registry_auth(registry_url, username, client.set_secret("registry-token", token))
                .publish(image_name)
            )
            print(f"✓ Published image to: {image_ref}")
            print(f"✓ Build number: {build_number} for {build_date}")
            print(f"✓ Project: {owner}/{repo_name}")
        else:
            print(f"⚠️  {token_env} not set - skipping publish to {registry_url}")
            print(f"   Set {token_env} to publish images to the registry")
        
        return image_ref


def get_next_build_number(build_date: str, project_name: str) -> int:
    """
    Get the next build number for today and this project.
    Stores counter in ~/.dagger/build-counters/{project_name}.txt
    Format: YYYYMMDD:N
    """
    counter_dir = Path.home() / ".dagger" / "build-counters"
    counter_dir.mkdir(parents=True, exist_ok=True)
    counter_file = counter_dir / f"{project_name}.txt"
    
    # Read existing counter
    if counter_file.exists():
        content = counter_file.read_text().strip()
        if content:
            stored_date, stored_number = content.split(":")
            if stored_date == build_date:
                # Same day, increment
                next_number = int(stored_number) + 1
            else:
                # New day, reset to 1
                next_number = 1
        else:
            next_number = 1
    else:
        next_number = 1
    
    # Write new counter
    counter_file.write_text(f"{build_date}:{next_number}")
    
    return next_number


if __name__ == "__main__":
    import anyio
    anyio.run(main)
