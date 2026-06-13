// 8Trax Mobile Enhancements

// Mobile navigation
function initMobileNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const views = {
    library: document.getElementById('library-view'),
    studio: document.getElementById('studio-view'),
    social: document.getElementById('social-view'),
    profile: document.getElementById('profile-view')
  };
  
  function switchView(viewName) {
    // Update nav items
    navItems.forEach(item => {
      if (item.dataset.view === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    
    // Update views
    Object.keys(views).forEach(key => {
      if (key === viewName) {
        views[key].classList.add('active');
      } else {
        views[key].classList.remove('active');
      }
    });
    
    // Refresh content when switching views
    if (viewName === 'library') {
      if (window.loadSongs) window.loadSongs();
    } else if (viewName === 'profile') {
      if (window.loadProfile) window.loadProfile();
    } else if (viewName === 'social') {
      if (window.loadMessages) window.loadMessages();
    }
  }
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
    });
  });
  
  return switchView;
}

// Toast notification
function showToast(message, duration = 3000) {
  let toast = document.querySelector('.toast');
  if (toast) toast.remove();
  
  toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, duration);
}

// Pull to refresh
function initPullToRefresh(callback) {
  let touchStart = 0;
  let refreshing = false;
  const container = document.querySelector('.view.active');
  
  if (!container) return;
  
  container.addEventListener('touchstart', (e) => {
    if (container.scrollTop === 0) {
      touchStart = e.touches[0].clientY;
    }
  });
  
  container.addEventListener('touchmove', (e) => {
    if (refreshing) return;
    const touchY = e.touches[0].clientY;
    const diff = touchY - touchStart;
    
    if (diff > 60 && container.scrollTop === 0) {
      refreshing = true;
      showToast('Refreshing...');
      if (callback) callback();
      setTimeout(() => {
        refreshing = false;
      }, 1000);
    }
  });
}

// Keyboard handling for mobile
function initKeyboardHandling() {
  const inputs = document.querySelectorAll('input, textarea');
  inputs.forEach(input => {
    input.addEventListener('focus', () => {
      setTimeout(() => {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    });
  });
}

// Prevent body scroll when modal is open
function initModalHandling() {
  const modals = document.querySelectorAll('.modal, .create-modal');
  const body = document.body;
  
  modals.forEach(modal => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'style') {
          if (modal.style.display === 'flex') {
            body.style.overflow = 'hidden';
          } else {
            body.style.overflow = '';
          }
        }
      });
    });
    
    observer.observe(modal, { attributes: true });
  });
}

// Enhanced touch feedback
function initTouchFeedback() {
  const interactiveElements = document.querySelectorAll('button, .song-card, .track-card, .nav-item');
  
  interactiveElements.forEach(el => {
    el.addEventListener('touchstart', () => {
      el.style.transition = 'transform 0.05s';
    });
    
    el.addEventListener('touchend', () => {
      setTimeout(() => {
        el.style.transition = '';
      }, 100);
    });
  });
}

// Mobile-specific UI adjustments
function initMobileUI() {
  // Hide comments panel on mobile - integrate into social view
  const commentsPanel = document.querySelector('.comments-panel');
  if (commentsPanel) {
    commentsPanel.style.display = 'none';
  }
  
  // Make sidebar hidden on mobile
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.style.display = 'none';
  }
}

// Initialize all mobile features
document.addEventListener('DOMContentLoaded', () => {
  initMobileNavigation();
  initKeyboardHandling();
  initModalHandling();
  initTouchFeedback();
  initMobileUI();
  
  // Expose showToast globally
  window.showToast = showToast;
});

// Override alert with toast for better UX
const originalAlert = window.alert;
window.alert = function(message) {
  if (window.innerWidth <= 768) {
    showToast(message);
  } else {
    originalAlert(message);
  }
};