// Dark mode toggle functionality
function toggleDarkMode() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  // Add animation class to trigger the moon phase transition
  const darkModeBtn = document.querySelector('.btn-dark');
  if (darkModeBtn) {
    darkModeBtn.style.backgroundPosition = newTheme === 'dark' ? 'right center' : 'left center';
  }
  
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// Initialize theme on page load
function initializeTheme() {
  const savedTheme = localStorage.getItem('theme');
  // Default to dark mode
  let currentTheme = savedTheme || 'dark';
  
  document.documentElement.setAttribute('data-theme', currentTheme);
  
  // Set initial moon phase position
  const darkModeBtn = document.querySelector('.btn-dark');
  if (darkModeBtn) {
    darkModeBtn.style.backgroundPosition = currentTheme === 'dark' ? 'right center' : 'left center';
  }
}

// Listen for system theme changes
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
    if (!localStorage.getItem('theme')) {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    }
  });
}

// Initialize theme when DOM is loaded
document.addEventListener('DOMContentLoaded', initializeTheme);

// Initialize theme immediately to prevent flash
initializeTheme();