// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link to clipboard
// - Toggling password visibility
// - Auto-filling the password from sessionStorage

// One region for the page announces every copy; the button flash is visual.
function setCopyStatus(message) {
    const region = document.getElementById('copy-status');
    if (region) region.textContent = message;
}

const copyFlashes = new WeakMap();

// Flash confirmation on the button and announce it. Only the visible label is
// rewritten: the button also carries a screen-reader-only prefix naming which
// link it copies, and setting textContent on the button itself would destroy it.
function flashCopied(button, message) {
    setCopyStatus(message);
    const label = button.querySelector('.copy-label');
    // A re-click mid-flash must not capture "Copied!" as the text to restore,
    // which would leave the label stuck on it.
    const pending = copyFlashes.get(button);
    if (pending) clearTimeout(pending.timer);
    const originalText = pending ? pending.originalText : (label ? label.textContent : '');

    if (label) label.textContent = 'Copied!';
    const timer = setTimeout(() => {
        if (label) label.textContent = originalText;
        copyFlashes.delete(button);
        // Emptying it means the next copy writes fresh text, which is what
        // makes assistive tech announce it again.
        setCopyStatus('');
    }, 2000);
    copyFlashes.set(button, { timer, originalText });
}

// Copy the share link to clipboard and show a temporary message
function copyLink() {
    const shareLink = document.getElementById('share-link');
    shareLink.select();
    document.execCommand('copy');
    flashCopied(shareLink.nextElementSibling, 'Link copied to clipboard.');
}

// Copy the share link with password to clipboard
function copyLinkWithPassword() {
    const shareLinkWithPassword = document.getElementById('share-link-with-password');
    shareLinkWithPassword.select();
    document.execCommand('copy');
    flashCopied(shareLinkWithPassword.nextElementSibling, 'One-click link copied to clipboard.');
}

// Toggle password field between 'password' and 'text' for user convenience
function togglePasswordVisibility() {
    const pwdInput = document.getElementById('password-display');
    const toggleBtn = document.getElementById('toggle-password');
    if (pwdInput.type === 'password') {
        pwdInput.type = 'text';
        toggleBtn.textContent = 'Hide';
        setTimeout(() => {
            pwdInput.type = 'password';
            toggleBtn.textContent = 'Show';
        }, 5000);
    } else {
        pwdInput.type = 'password';
        toggleBtn.textContent = 'Show';
    }
}

// On page load, auto-fill password from sessionStorage if present
// (This helps the user copy/share the password after upload)
document.addEventListener('DOMContentLoaded', function() {
    const pwd = sessionStorage.getItem('uploadPassword');
    if (pwd) {
        document.getElementById('password-display').value = pwd;

        // Generate link with password in URL fragment
        const shareLink = document.getElementById('share-link').value;
        const linkWithPassword = shareLink + '#' + encodeURIComponent(pwd);
        document.getElementById('share-link-with-password').value = linkWithPassword;

        sessionStorage.removeItem('uploadPassword');
    }
});
