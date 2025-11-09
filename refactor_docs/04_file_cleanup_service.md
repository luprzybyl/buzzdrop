# Automated File Cleanup Service

**Priority**: Low  
**Estimated Effort**: 3-4 hours  
**Status**: Proposal

## Current Issue

File expiry is only checked when files are accessed (`check_and_handle_expiry()` called on-demand). This means:

- Expired files remain in storage until someone tries to access them
- No proactive cleanup of old files
- Wasted storage space
- Manual cleanup required for orphaned files

## Proposal

Implement a background cleanup service that runs periodically to remove expired files and orphaned data.

### Implementation

```python
# services/cleanup.py
import threading
import time
from datetime import datetime
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class CleanupService:
    """
    Background service for cleaning up expired and orphaned files.
    """
    
    def __init__(self, app, storage_backend, file_repository, interval_minutes: int = 60):
        """
        Initialize cleanup service.
        
        Args:
            app: Flask application instance
            storage_backend: Storage backend instance
            file_repository: File repository instance
            interval_minutes: How often to run cleanup (default 60 minutes)
        """
        self.app = app
        self.storage = storage_backend
        self.file_repo = file_repository
        self.interval = interval_minutes * 60  # Convert to seconds
        self.running = False
        self.thread: Optional[threading.Thread] = None
    
    def cleanup_expired_files(self):
        """
        Remove expired files from storage and mark them in database.
        """
        with self.app.app_context():
            try:
                all_files = self.file_repo.get_all_active()
                now = datetime.now()
                cleaned_count = 0
                
                for file_info in all_files:
                    expiry_at = file_info.get('expiry_at')
                    if not expiry_at:
                        continue
                    
                    try:
                        expiry_dt = datetime.fromisoformat(expiry_at)
                        if now >= expiry_dt:
                            # Delete from storage
                            self.storage.delete(file_info['path'])
                            
                            # Mark as expired in database
                            self.file_repo.mark_expired(file_info['id'])
                            
                            logger.info(
                                f"Cleaned up expired file: {file_info['id']} "
                                f"(expired at {expiry_at})"
                            )
                            cleaned_count += 1
                    
                    except ValueError as e:
                        logger.error(
                            f"Invalid expiry date for file {file_info['id']}: {expiry_at}",
                            exc_info=True
                        )
                    except Exception as e:
                        logger.error(
                            f"Failed to cleanup file {file_info['id']}: {e}",
                            exc_info=True
                        )
                
                if cleaned_count > 0:
                    logger.info(f"Cleanup completed: {cleaned_count} expired files removed")
                else:
                    logger.debug("Cleanup completed: no expired files found")
                
            except Exception as e:
                logger.error(f"Cleanup cycle failed: {e}", exc_info=True)
    
    def cleanup_orphaned_files(self):
        """
        Remove files from storage that are not tracked in database.
        Only applicable for local storage.
        """
        if self.storage.backend_type != 'local':
            return
        
        with self.app.app_context():
            try:
                # Get files in storage
                storage_files = set(self.storage.list_files())
                
                # Get files in database
                tracked_files = set(
                    f['path'].split('/')[-1] 
                    for f in self.file_repo.get_all()
                )
                
                # Find orphans
                orphaned = storage_files - tracked_files
                
                if orphaned:
                    logger.info(f"Found {len(orphaned)} orphaned files")
                    
                    for file_name in orphaned:
                        try:
                            self.storage.delete_by_name(file_name)
                            logger.info(f"Removed orphaned file: {file_name}")
                        except Exception as e:
                            logger.error(
                                f"Failed to remove orphaned file {file_name}: {e}",
                                exc_info=True
                            )
                else:
                    logger.debug("No orphaned files found")
                    
            except Exception as e:
                logger.error(f"Orphaned files cleanup failed: {e}", exc_info=True)
    
    def cleanup_old_downloaded_files(self, days: int = 7):
        """
        Remove database entries for files downloaded more than N days ago.
        
        Args:
            days: Number of days to keep downloaded file records
        """
        with self.app.app_context():
            try:
                from datetime import timedelta
                cutoff = datetime.now() - timedelta(days=days)
                
                old_files = self.file_repo.get_downloaded_before(cutoff)
                
                if old_files:
                    logger.info(
                        f"Found {len(old_files)} file records downloaded "
                        f"more than {days} days ago"
                    )
                    
                    for file_info in old_files:
                        try:
                            self.file_repo.delete(file_info['id'])
                            logger.info(
                                f"Removed old file record: {file_info['id']} "
                                f"(downloaded at {file_info['downloaded_at']})"
                            )
                        except Exception as e:
                            logger.error(
                                f"Failed to remove old record {file_info['id']}: {e}",
                                exc_info=True
                            )
                else:
                    logger.debug(f"No file records older than {days} days found")
                    
            except Exception as e:
                logger.error(f"Old records cleanup failed: {e}", exc_info=True)
    
    def run_cleanup_cycle(self):
        """
        Execute all cleanup tasks in one cycle.
        """
        logger.info("Starting cleanup cycle")
        start_time = time.time()
        
        # Run cleanup tasks
        self.cleanup_expired_files()
        self.cleanup_orphaned_files()
        self.cleanup_old_downloaded_files(days=7)
        
        elapsed = time.time() - start_time
        logger.info(f"Cleanup cycle completed in {elapsed:.2f} seconds")
    
    def _cleanup_loop(self):
        """
        Main loop that runs cleanup periodically.
        """
        logger.info(
            f"Cleanup service started (interval: {self.interval // 60} minutes)"
        )
        
        while self.running:
            try:
                self.run_cleanup_cycle()
            except Exception as e:
                logger.error(f"Cleanup cycle error: {e}", exc_info=True)
            
            # Sleep for interval
            time.sleep(self.interval)
        
        logger.info("Cleanup service stopped")
    
    def start(self):
        """
        Start the background cleanup service.
        """
        if self.running:
            logger.warning("Cleanup service already running")
            return
        
        self.running = True
        self.thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self.thread.start()
        logger.info("Cleanup service thread started")
    
    def stop(self):
        """
        Stop the background cleanup service.
        """
        if not self.running:
            logger.warning("Cleanup service not running")
            return
        
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
        logger.info("Cleanup service stopped")
```

### Usage in app.py

```python
# app.py
from services.cleanup import CleanupService

# Initialize app, storage, repository...
app = Flask(__name__)
storage = get_storage_backend(app.config)
file_repo = FileRepository()

# Initialize cleanup service
cleanup_service = CleanupService(
    app=app,
    storage_backend=storage,
    file_repository=file_repo,
    interval_minutes=60  # Run every hour
)

# Start cleanup service
cleanup_service.start()

if __name__ == '__main__':
    try:
        app.run()
    finally:
        cleanup_service.stop()
```

### Configuration

```python
# config.py
class Config:
    # Cleanup settings
    CLEANUP_ENABLED = os.getenv('CLEANUP_ENABLED', 'true').lower() == 'true'
    CLEANUP_INTERVAL_MINUTES = int(os.getenv('CLEANUP_INTERVAL_MINUTES', 60))
    CLEANUP_OLD_FILES_DAYS = int(os.getenv('CLEANUP_OLD_FILES_DAYS', 7))
```

### Environment Variables

```bash
# .env
CLEANUP_ENABLED=true
CLEANUP_INTERVAL_MINUTES=60  # Run every hour
CLEANUP_OLD_FILES_DAYS=7     # Keep download records for 7 days
```

## Cleanup Tasks

### 1. Expired Files
- Checks all active files for `expiry_at` timestamp
- Deletes file from storage if past expiry
- Marks as `expired` in database
- Logs cleanup actions

### 2. Orphaned Files (Local Storage Only)
- Lists all files in upload directory
- Compares with database tracked files
- Removes files not in database
- Prevents storage bloat from failed uploads

### 3. Old Downloaded Files
- Finds files downloaded > N days ago
- Removes database entries (file already deleted)
- Keeps database clean
- Configurable retention period

## Manual Cleanup Endpoint (Optional)

```python
# app.py
@app.route('/admin/cleanup', methods=['POST'])
@admin_required
def manual_cleanup():
    """
    Manually trigger cleanup cycle (admin only).
    """
    try:
        cleanup_service.run_cleanup_cycle()
        flash('Cleanup completed successfully')
    except Exception as e:
        app.logger.error(f"Manual cleanup failed: {e}", exc_info=True)
        flash('Cleanup failed')
    
    return redirect(url_for('admin_dashboard'))
```

## Monitoring

### Cleanup Statistics

```python
# services/cleanup.py
class CleanupService:
    def __init__(self, ...):
        # ... existing init ...
        self.stats = {
            'total_cycles': 0,
            'expired_files_removed': 0,
            'orphaned_files_removed': 0,
            'old_records_removed': 0,
            'last_run': None,
            'last_duration': 0
        }
    
    def run_cleanup_cycle(self):
        self.stats['total_cycles'] += 1
        self.stats['last_run'] = datetime.now()
        # ... existing cleanup logic ...
        self.stats['last_duration'] = elapsed
    
    def get_stats(self):
        """Return cleanup statistics."""
        return self.stats.copy()
```

### Admin Dashboard

```python
@app.route('/admin/stats')
@admin_required
def admin_stats():
    """Show cleanup statistics."""
    stats = cleanup_service.get_stats()
    return render_template('admin/stats.html', cleanup_stats=stats)
```

## Testing

```python
# tests/unit/test_cleanup.py
import pytest
from datetime import datetime, timedelta
from services.cleanup import CleanupService

def test_cleanup_expired_files(app, file_repo, storage):
    # Create expired file
    yesterday = (datetime.now() - timedelta(days=1)).isoformat()
    file_id = file_repo.create({
        'original_name': 'test.txt',
        'path': 'uploads/test123',
        'uploaded_by': 'testuser',
        'expiry_at': yesterday,
        'status': 'active'
    })
    
    # Run cleanup
    cleanup = CleanupService(app, storage, file_repo, interval_minutes=60)
    cleanup.cleanup_expired_files()
    
    # Verify file marked as expired
    file_info = file_repo.get_by_id(file_id)
    assert file_info['status'] == 'expired'

def test_cleanup_orphaned_files(app, file_repo, storage, tmp_path):
    # Create orphaned file in storage
    orphaned_path = tmp_path / 'orphaned.txt'
    orphaned_path.write_text('orphaned')
    
    # Run cleanup
    cleanup = CleanupService(app, storage, file_repo, interval_minutes=60)
    cleanup.cleanup_orphaned_files()
    
    # Verify orphaned file removed
    assert not orphaned_path.exists()
```

## Benefits

1. **Proactive Cleanup**: Don't wait for files to be accessed
2. **Storage Optimization**: Automatically free up space
3. **Audit Trail**: Logs all cleanup actions
4. **Configurable**: Adjust intervals and retention
5. **Monitoring**: Track cleanup statistics
6. **Low Overhead**: Runs in background thread

## Production Considerations

### Performance
- Cleanup runs in separate thread (non-blocking)
- Configurable interval prevents excessive I/O
- Batch operations for efficiency

### Reliability
- Exception handling prevents service crashes
- Continues on individual file failures
- Logs all errors for debugging

### Resource Usage
- Minimal memory footprint
- I/O bound operations
- Daemon thread exits cleanly on shutdown

## Alternative Approaches

### Cron Job (Linux)
```bash
# /etc/cron.d/buzzdrop-cleanup
0 * * * * /path/to/venv/bin/python /path/to/cleanup_script.py
```

### Celery Task (Distributed)
```python
# tasks.py
from celery import Celery

celery = Celery('buzzdrop')

@celery.task
def cleanup_expired_files():
    # Cleanup logic
    pass

# Beat schedule
celery.conf.beat_schedule = {
    'cleanup-every-hour': {
        'task': 'tasks.cleanup_expired_files',
        'schedule': 3600.0,
    },
}
```

### Cloud Function (Serverless)
```python
# For AWS Lambda / GCP Cloud Functions
def cleanup_handler(event, context):
    # Cleanup logic
    pass
```

## Migration Path

1. Implement `CleanupService` class
2. Test in development with short intervals (5 minutes)
3. Deploy with monitoring enabled
4. Observe logs for a week
5. Adjust intervals based on usage patterns
6. Consider moving to cron if needed
