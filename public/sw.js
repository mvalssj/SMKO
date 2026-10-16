/* SMKO offline shell and notification worker. Kept dependency-free so it is served verbatim by Vite. */
const CACHE = 'smko-shell-v1';
const CORE = ['/', '/manifest.webmanifest', '/icons/smko-192.png', '/icons/smko-512.png', '/icons/smko.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/', { cache: 'no-cache' });
    await cache.put('/', response.clone());
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"?#]+(?:\?[^"#]*)?)"/g)]
      .map((m) => new URL(m[1], self.location.origin).pathname)
      .filter((url) => url.startsWith('/'));
    await cache.addAll([...new Set([...CORE, ...assets])]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('smko-') && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put('/', copy));
      return response;
    }).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = data.title || 'SMKO';
  const options = {
    body: data.body || 'Há uma novidade no SMKO.',
    icon: '/icons/smko-192.png',
    badge: '/icons/smko-192.png',
    tag: data.tag || 'smko-notice',
    renotify: Boolean(data.renotify),
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
