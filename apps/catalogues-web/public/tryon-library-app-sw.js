// Minimal service worker — exists only to satisfy Chrome's PWA install-eligibility
// criteria (a registered SW with a fetch handler). No offline caching is done here.
self.addEventListener('fetch', () => {});
