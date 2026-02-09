/**
 * Toast notification system.
 */

/**
 * @param {string} message
 * @param {'info' | 'error' | 'success'} [type]
 */
export function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `fixed top-4 right-4 px-6 py-3 rounded-md shadow-lg z-50 transition-opacity duration-300 ${
    type === 'error'
      ? 'bg-red-500 text-white'
      : type === 'success'
        ? 'bg-green-500 text-white'
        : 'bg-nlr-blue text-white'
  }`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('opacity-0');
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}
