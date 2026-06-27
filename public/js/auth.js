document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const errorEl = document.getElementById('auth-error');

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const btn = document.getElementById('btn-login');

      await handleAuth('/api/login', { username, password }, btn, errorEl);
    });
  }

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm-password').value;
      const btn = document.getElementById('btn-signup');

      if (password !== confirm) {
        showError(errorEl, 'Passwords do not match');
        return;
      }

      await handleAuth('/api/signup', { username, email, password }, btn, errorEl);
    });
  }
});

async function handleAuth(url, data, btn, errorEl) {
  errorEl.style.display = 'none';
  btn.classList.add('loading');
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    const result = await res.json();
    
    if (result.success) {
      // Save token
      localStorage.setItem('gpa_token', result.token);
      localStorage.setItem('gpa_username', result.username);
      
      // If signup, show success popup before redirect
      if (url === '/api/signup') {
        showSuccessPopup('Your account has been created!', () => {
          window.location.href = '/';
        });
      } else {
        window.location.href = '/';
      }
    } else {
      showError(errorEl, result.error || 'Authentication failed');
    }
  } catch (err) {
    showError(errorEl, 'Server connection error');
  } finally {
    btn.classList.remove('loading');
  }
}

function showSuccessPopup(message, callback) {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0'; overlay.style.left = '0';
  overlay.style.width = '100%'; overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(15, 23, 42, 0.8)';
  overlay.style.backdropFilter = 'blur(4px)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 0.3s ease';

  const popup = document.createElement('div');
  popup.style.background = 'var(--glass-bg, #1e293b)';
  popup.style.padding = '32px 48px';
  popup.style.borderRadius = 'var(--radius-lg, 16px)';
  popup.style.boxShadow = '0 12px 32px rgba(0, 206, 201, 0.15)';
  popup.style.border = '1px solid var(--glass-border, rgba(255, 255, 255, 0.1))';
  popup.style.textAlign = 'center';
  popup.style.transform = 'scale(0.8) translateY(20px)';
  popup.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
  
  popup.innerHTML = `
    <div style="font-size: 3.5rem; margin-bottom: 12px; animation: bounce 2s infinite;">🎉</div>
    <h3 style="color: var(--text-primary, #fff); font-size: 1.6rem; margin-bottom: 8px; font-weight: 700;">Awesome!</h3>
    <p style="color: var(--text-secondary, #94a3b8); font-size: 1.05rem;">${message}</p>
  `;

  overlay.appendChild(popup);
  document.body.appendChild(overlay);

  // Trigger entrance animation
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    popup.style.transform = 'scale(1) translateY(0)';
  });

  // Wait 2 seconds, then fade out and execute callback
  setTimeout(() => {
    overlay.style.opacity = '0';
    popup.style.transform = 'scale(0.9) translateY(10px)';
    setTimeout(() => {
      if (document.body.contains(overlay)) {
        document.body.removeChild(overlay);
      }
      if (callback) callback();
    }, 300);
  }, 2200);
}

function showError(el, message) {
  el.textContent = message;
  el.style.display = 'block';
}

// Utility for getting auth header
window.getAuthHeaders = function() {
  const token = localStorage.getItem('gpa_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};
