'use strict';

// ---------- Navigation zwischen den drei Bildschirmen ----------
const tabs = document.querySelectorAll('.tab');
const screens = document.querySelectorAll('.screen');
const title = document.getElementById('screen-title');

function showScreen(name) {
  screens.forEach((screen) => {
    const active = screen.id === 'screen-' + name;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
  });

  tabs.forEach((tab) => {
    const active = tab.dataset.screen === name;
    tab.classList.toggle('is-active', active);
    if (active) {
      tab.setAttribute('aria-current', 'page');
      title.textContent = tab.dataset.title;
    } else {
      tab.removeAttribute('aria-current');
    }
  });

  document.querySelector('.app-main').scrollTop = 0;
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => showScreen(tab.dataset.screen));
});

// ---------- Service Worker (macht die App offline-fähig) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service Worker konnte nicht registriert werden:', err);
    });
  });
}
