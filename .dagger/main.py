#!/usr/bin/env python3
"""
Dagger pipeline for Buzzdrop
Runs tests, builds Docker image, and publishes to registry
"""
import os
import sys
from datetime import datetime
from pathlib import Path

import dagger


async def main():
    config = dagger.Config(log_output=sys.stderr)
    
    async with dagger.Connection(config) as client:
        # Get the source code directory
        # Exclude unnecessary files and directories
        source = client.host().directory(
            ".",
            exclude=[
                ".venv/",
                ".git/",
                ".pytest_cache/",
                "__pycache__/",
                "uploads/",
                "db.json",
                ".env",
                "*.pyc",
                ".dagger/",
                "sdk/",
            ]
        )
        
        # Build the test container
        python_version = "3.15-rc-alpine3.22"
        test_container = (
            client.container()
            .from_(f"python:{python_version}")
            .with_workdir("/app")
            .with_directory("/app", source)
            .with_exec(["pip", "install", "--no-cache-dir", "-r", "requirements.txt"])
        )
        
        # Run tests
        print("Running tests...")
        test_result = await test_container.with_exec(["pytest", "-v"]).stdout()
        print(test_result)
        
        # Build the Docker image using the Dockerfile
        print("Building Docker image...")
        docker_image = (
            client.container()
            .from_(f"python:{python_version}")
            .with_env_variable("PYTHONDONTWRITEBYTECODE", "1")
            .with_env_variable("PYTHONUNBUFFERED", "1")
            .with_workdir("/app")
            .with_file("/app/requirements.txt", source.file("requirements.txt"))
            .with_exec(["pip", "install", "--no-cache-dir", "-r", "requirements.txt"])
            .with_directory("/app", source)
            .with_exec(["mkdir", "-p", "uploads"])
            .with_env_variable("FLASK_APP", "app.py")
            .with_env_variable("FLASK_RUN_HOST", "0.0.0.0")
            .with_exposed_port(5000)
            .with_entrypoint(["flask", "run"])
        )
        
        # Get build versioning info
        repo_name = "buzzdrop"  # Extract from git remote
        build_date = datetime.now().strftime("%Y%m%d")
        build_number = get_next_build_number(build_date)
        image_tag = f"{build_date}-{build_number}"
        
        # Publish to GitHub Container Registry
        # Requires GITHUB_TOKEN environment variable with write:packages permission
        github_token = os.getenv("GITHUB_TOKEN")
        
        if github_token:
            image_name = f"ghcr.io/luprzybyl/{repo_name}:{image_tag}"
            print(f"Publishing image to {image_name}...")
            
            image_ref = await (
                docker_image
                .with_registry_auth("ghcr.io", "luprzybyl", client.set_secret("github-token", github_token))
                .publish(image_name)
            )
            print(f"✓ Published image to: {image_ref}")
            print(f"✓ Build number: {build_number} for {build_date}")
        else:
            print("⚠️  GITHUB_TOKEN not set - skipping publish to GHCR")
            print("   Set GITHUB_TOKEN to publish images to GitHub Container Registry")
            image_ref = None
        
        return image_ref


def get_next_build_number(build_date: str) -> int:
    """
    Get the next build number for today.
    Stores counter in ~/.dagger/build-counter.txt
    Format: YYYYMMDD:N
    """
    counter_file = Path.home() / ".dagger" / "build-counter.txt"
    counter_file.parent.mkdir(exist_ok=True)
    
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
