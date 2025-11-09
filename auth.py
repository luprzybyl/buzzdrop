"""
Authentication module for Buzzdrop.
Handles user management and authentication decorators.
"""
import os
from functools import wraps, lru_cache
from flask import session, flash, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash


def hash_password(password: str) -> str:
    """
    Hash a password using PBKDF2-SHA256 with salt.
    
    Args:
        password: Plain text password
    
    Returns:
        Hashed password string
    """
    return generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)


@lru_cache(maxsize=None)
def get_users() -> dict:
    """
    Get all users from environment variables.
    Results are cached to avoid repeated hashing.
    
    Environment variables should be in format:
        FLASK_USER_N=username:password:is_admin
    
    Example:
        FLASK_USER_1=admin:secretpass:true
        FLASK_USER_2=user:password:false
    
    Returns:
        Dictionary mapping usernames to user data:
        {
            'username': {
                'password': 'hashed_password',
                'is_admin': bool
            }
        }
    """
    users = {}
    
    for key, value in os.environ.items():
        if key.startswith('FLASK_USER_'):
            try:
                # Extract parts from the value
                username, password, is_admin_str = value.split(':', 2)
                users[username] = {
                    'password': hash_password(password),
                    'is_admin': is_admin_str.lower() == 'true'
                }
            except ValueError:
                # Handle cases where the value might not have enough parts
                print(f"Warning: Invalid user format in environment variable {key}")
    
    return users


def verify_password(username: str, password: str) -> bool:
    """
    Verify username and password combination.
    
    Args:
        username: Username to verify
        password: Plain text password to check
    
    Returns:
        True if credentials are valid, False otherwise
    """
    users = get_users()
    user = users.get(username)
    
    if not user:
        return False
    
    return check_password_hash(user['password'], password)


def is_admin(username: str) -> bool:
    """
    Check if user has admin privileges.
    
    Args:
        username: Username to check
    
    Returns:
        True if user is admin, False otherwise
    """
    users = get_users()
    user = users.get(username)
    
    if not user:
        return False
    
    return user.get('is_admin', False)


def get_current_user() -> dict:
    """
    Get current logged-in user information.
    
    Returns:
        Dictionary with user info if logged in, None otherwise:
        {
            'username': str,
            'is_admin': bool
        }
    """
    username = session.get('username')
    
    if not username:
        return None
    
    return {
        'username': username,
        'is_admin': session.get('is_admin', False)
    }


def login_required(f):
    """
    Decorator to require login for a route.
    
    Usage:
        @app.route('/protected')
        @login_required
        def protected_route():
            # Only accessible to logged-in users
            pass
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            flash('Please log in to access this page')
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    
    return decorated_function


def admin_required(f):
    """
    Decorator to require admin privileges for a route.
    
    Usage:
        @app.route('/admin')
        @admin_required
        def admin_route():
            # Only accessible to admin users
            pass
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            flash('Please log in to access this page')
            return redirect(url_for('login'))
        
        users = get_users()
        user = users.get(session['username'])
        
        if not user or not user['is_admin']:
            flash('Admin access required')
            return redirect(url_for('index'))
        
        return f(*args, **kwargs)
    
    return decorated_function


def login_user(username: str, password: str) -> bool:
    """
    Attempt to log in a user.
    
    Args:
        username: Username
        password: Plain text password
    
    Returns:
        True if login successful, False otherwise
    """
    if not verify_password(username, password):
        return False
    
    users = get_users()
    user = users.get(username)
    
    # Set session data
    session['username'] = username
    session['is_admin'] = user.get('is_admin', False)
    
    return True


def logout_user():
    """Log out the current user by clearing session."""
    session.pop('username', None)
    session.pop('is_admin', None)
