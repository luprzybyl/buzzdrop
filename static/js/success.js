function copyLink() {
    const shareLink = document.getElementById('share-link');
    shareLink.select();
    document.execCommand('copy');

    const button = shareLink.nextElementSibling;
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => {
        button.textContent = originalText;
    }, 2000);
}

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

document.addEventListener('DOMContentLoaded', function() {
    const pwd = sessionStorage.getItem('uploadPassword');
    if (pwd) {
        document.getElementById('password-display').value = pwd;
        sessionStorage.removeItem('uploadPassword');
    }
});
