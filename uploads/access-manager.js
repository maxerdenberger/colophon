// Access Management System for Colophon
// Add this to bench.html to handle day/week/month passes

class AccessManager {
  constructor() {
    this.checkAccess();
  }

  checkAccess() {
    const urlParams = new URLSearchParams(window.location.search);
    const key = urlParams.get('key');
    
    if (!key) {
      this.redirectToPaywall();
      return;
    }

    // Check if key is valid and not expired
    this.validateKey(key);
  }

  validateKey(key) {
    // In production, this would check against your database
    // For now, we'll use localStorage to simulate expiring access
    
    const accessData = localStorage.getItem(`access_${key}`);
    
    if (!accessData) {
      // First time using this key - set expiration based on purchase
      this.initializeAccess(key);
      return;
    }

    const { expiry, type } = JSON.parse(accessData);
    const now = Date.now();

    if (now > expiry) {
      this.showExpiredMessage(type);
      return;
    }

    this.showRemainingTime(expiry, type);
  }

  initializeAccess(key) {
    // Detect purchase type from Stripe metadata or key format
    // For demo, let's assume format: daypass_123, weekpass_456, monthly_789
    
    let duration, type;
    
    if (key.startsWith('day_')) {
      duration = 24 * 60 * 60 * 1000; // 24 hours
      type = 'day';
    } else if (key.startsWith('week_')) {
      duration = 7 * 24 * 60 * 60 * 1000; // 7 days
      type = 'week';
    } else if (key.startsWith('month_')) {
      duration = 30 * 24 * 60 * 60 * 1000; // 30 days
      type = 'month';
    } else {
      // Default to day pass
      duration = 24 * 60 * 60 * 1000;
      type = 'day';
    }

    const expiry = Date.now() + duration;
    
    localStorage.setItem(`access_${key}`, JSON.stringify({
      expiry,
      type,
      startDate: Date.now()
    }));

    this.showWelcomeMessage(type);
  }

  showRemainingTime(expiry, type) {
    const remaining = expiry - Date.now();
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const days = Math.floor(hours / 24);

    let message;
    if (days > 0) {
      message = `${days} day${days > 1 ? 's' : ''} remaining on your ${type} pass`;
    } else {
      message = `${hours} hour${hours > 1 ? 's' : ''} remaining on your ${type} pass`;
    }

    this.showStatusBar(message, 'active');
  }

  showExpiredMessage(type) {
    this.showStatusBar(`Your ${type} pass has expired. Get a new pass to continue.`, 'expired');
    
    setTimeout(() => {
      window.location.href = 'pricing.html';
    }, 3000);
  }

  showWelcomeMessage(type) {
    this.showStatusBar(`Welcome! Your ${type} pass is now active.`, 'welcome');
  }

  showStatusBar(message, status) {
    const statusBar = document.createElement('div');
    statusBar.className = `access-status ${status}`;
    statusBar.textContent = message;
    
    statusBar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: ${status === 'expired' ? '#ff6b35' : status === 'welcome' ? '#28a745' : '#666'};
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-size: 11px;
      z-index: 1000;
      font-family: 'SF Pro Text', sans-serif;
    `;

    document.body.prepend(statusBar);

    if (status === 'welcome') {
      setTimeout(() => statusBar.remove(), 5000);
    }
  }

  redirectToPaywall() {
    // Show brief message then redirect
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      color: white;
      text-align: center;
      font-family: 'SF Pro Text', sans-serif;
    `;
    
    overlay.innerHTML = `
      <div>
        <h2 style="margin-bottom: 16px;">Access Required</h2>
        <p>Redirecting to get access...</p>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    setTimeout(() => {
      window.location.href = 'pricing.html';
    }, 2000);
  }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
  new AccessManager();
});
