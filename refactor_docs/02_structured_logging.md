# Structured Logging Implementation

**Priority**: Medium  
**Estimated Effort**: 2-3 hours  
**Status**: Proposal

## Current Issue

The application uses `print()` statements throughout the code for debugging and informational messages:

```python
# Line 336
print("user_files: ", user_files)

# Line 191
print(f"Removed orphaned file: {orphaned_file}")

# Lines 653-654
print("upload folder: " + app.config['UPLOAD_FOLDER'])
print("database path: " + app.config['DATABASE_PATH'])
```

**Problems**:
- No log levels (can't filter debug vs errors)
- No timestamps
- No contextual information
- Goes to stdout only (no file logging)
- Hard to search/parse in production

## Proposal

Implement Python's standard `logging` module with proper configuration.

### Implementation

```python
# utils.py (or logging_config.py)
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

def setup_logging(app):
    """
    Configure application logging with console and file handlers.
    
    Args:
        app: Flask application instance
    """
    # Determine log level based on environment
    if app.config.get('TESTING'):
        log_level = logging.WARNING  # Reduce noise in tests
    elif app.debug:
        log_level = logging.DEBUG
    else:
        log_level = logging.INFO
    
    # Create logs directory
    logs_dir = Path('logs')
    logs_dir.mkdir(exist_ok=True)
    
    # Console handler (always on)
    console_handler = logging.StreamHandler()
    console_handler.setLevel(log_level)
    console_formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(console_formatter)
    
    # File handler (production only)
    if not app.debug:
        file_handler = RotatingFileHandler(
            'logs/buzzdrop.log',
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=10
        )
        file_handler.setLevel(logging.INFO)
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - '
            '[%(filename)s:%(lineno)d] - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        app.logger.addHandler(file_handler)
    
    # Error file handler (always on)
    error_handler = RotatingFileHandler(
        'logs/errors.log',
        maxBytes=10 * 1024 * 1024,  # 10MB
        backupCount=5
    )
    error_handler.setLevel(logging.ERROR)
    error_formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - '
        '[%(filename)s:%(lineno)d] - %(message)s\n'
        'Exception: %(exc_info)s'
    )
    error_handler.setFormatter(error_formatter)
    
    # Add handlers
    app.logger.addHandler(console_handler)
    app.logger.addHandler(error_handler)
    app.logger.setLevel(log_level)
    
    # Log startup info
    app.logger.info(f"Buzzdrop starting with log level: {logging.getLevelName(log_level)}")
    app.logger.info(f"Storage backend: {app.config.get('STORAGE_BACKEND', 'local')}")
    app.logger.info(f"Upload folder: {app.config.get('UPLOAD_FOLDER')}")
    app.logger.info(f"Database path: {app.config.get('DATABASE_PATH')}")
```

### Usage in app.py

```python
# app.py
from flask import Flask, current_app
from utils import setup_logging

app = Flask(__name__)
# ... config loading ...
setup_logging(app)

@app.route('/')
def index():
    if 'username' in session:
        user_files = files_table.search(File.uploaded_by == session['username'])
        current_app.logger.debug(f"Fetched {len(user_files)} files for user {session['username']}")
        # ... rest of logic
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    file = request.files['file']
    current_app.logger.info(
        f"File upload started: {file.filename} by {session['username']}, "
        f"size: {len(file.read())} bytes"
    )
    file.seek(0)  # Reset after reading size
    
    # ... upload logic ...
    
    current_app.logger.info(f"File uploaded successfully: {unique_id}")
    return render_template('success.html', share_link=share_link)

def cleanup_orphaned_files():
    """Remove any files not tracked in the database."""
    orphaned_files = uploaded_files - tracked_files
    
    for orphaned_file in orphaned_files:
        try:
            file_path = os.path.join(upload_dir, orphaned_file)
            os.remove(file_path)
            current_app.logger.info(f"Removed orphaned file: {orphaned_file}")
        except Exception as e:
            current_app.logger.error(
                f"Error removing orphaned file {orphaned_file}: {str(e)}",
                exc_info=True
            )

@app.route('/login', methods=['POST'])
def login():
    username = request.form.get('username')
    user = users.get(username)
    
    if user and check_password_hash(user['password'], password):
        session['username'] = username
        current_app.logger.info(f"Successful login: {username}")
        return redirect(url_for('index'))
    else:
        current_app.logger.warning(
            f"Failed login attempt for username: {username} "
            f"from IP: {request.remote_addr}"
        )
        flash('Invalid username or password')
        return render_template('login.html')
```

### Storage Backend Logging

```python
# storage.py
import logging

logger = logging.getLogger(__name__)

class S3Storage(StorageBackend):
    def save(self, file_id: str, data: bytes) -> str:
        try:
            s3_key = f"uploads/{file_id}"
            self.client.upload_fileobj(BytesIO(data), self.bucket, s3_key)
            logger.info(f"S3 upload successful: {file_id}, size: {len(data)} bytes")
            return s3_key
        except ClientError as e:
            logger.error(f"S3 upload failed for {file_id}: {e}", exc_info=True)
            raise
```

## Log Levels Guide

### DEBUG
- Detailed diagnostic information
- Variable values, query results
- Only visible in development

```python
app.logger.debug(f"User files query result: {user_files}")
app.logger.debug(f"Expiry check for file {file_id}: {is_expired}")
```

### INFO
- General informational messages
- Successful operations
- System state changes

```python
app.logger.info(f"File uploaded: {file_id} by {username}")
app.logger.info(f"File downloaded: {file_id} by IP {client_ip}")
app.logger.info("Orphaned file cleanup completed: 3 files removed")
```

### WARNING
- Recoverable issues
- Unexpected but handled situations

```python
app.logger.warning(f"Failed login attempt: {username} from {ip}")
app.logger.warning(f"File already downloaded: {file_id}")
app.logger.warning(f"Invalid user format in env: {key}")
```

### ERROR
- Error conditions
- Failed operations
- Exceptions

```python
app.logger.error(f"S3 connection failed: {str(e)}", exc_info=True)
app.logger.error(f"Database operation failed: {str(e)}", exc_info=True)
app.logger.error(f"File deletion failed: {file_path}", exc_info=True)
```

### CRITICAL
- System-level failures
- Data corruption
- Security breaches

```python
app.logger.critical("Database file corrupted, cannot start application")
app.logger.critical(f"Unauthorized admin access attempt: {username}")
```

## Benefits

1. **Filterable**: Can set different levels per environment
2. **Searchable**: Structured format easy to grep/parse
3. **Rotation**: Old logs automatically archived
4. **Contextual**: Includes timestamps, file/line numbers
5. **Production-ready**: Separate error logs
6. **Performance**: File logging in production only

## Migration Checklist

- [ ] Create `utils.py` with `setup_logging()`
- [ ] Replace all `print()` with `app.logger.*`
- [ ] Add `logs/` to `.gitignore`
- [ ] Test log rotation (create 11MB+ logs)
- [ ] Verify error logs capture exceptions
- [ ] Document log locations in README

## Production Considerations

### Log Management
```bash
# View recent logs
tail -f logs/buzzdrop.log

# Search for errors
grep "ERROR" logs/buzzdrop.log

# Find specific user activity
grep "username:testuser" logs/buzzdrop.log
```

### Log Rotation
- Files rotate at 10MB
- Keep 10 backups (100MB total)
- Error logs keep 5 backups

### Integration with Log Aggregation
- Logs are in standard format
- Easy to ship to ELK, Splunk, DataDog
- Consider structured JSON logging for production:

```python
import json

json_formatter = logging.Formatter(
    json.dumps({
        'timestamp': '%(asctime)s',
        'level': '%(levelname)s',
        'logger': '%(name)s',
        'message': '%(message)s',
        'file': '%(filename)s',
        'line': '%(lineno)d'
    })
)
```

## Security Notes

- **Never log passwords or encryption keys**
- **Sanitize file paths** (avoid exposing system structure)
- **Redact S3 bucket names** in production
- **Mask IP addresses** if required by GDPR

Example sanitization:
```python
# Bad
app.logger.info(f"Password check for {password}")

# Good
app.logger.info(f"Password check for user {username}")

# Bad  
app.logger.info(f"S3 bucket: {S3_BUCKET}")

# Good
app.logger.info(f"S3 backend enabled")
```
