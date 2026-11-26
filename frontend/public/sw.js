// ============================================================
// BANKERCHANGER — Service Worker
// Caching strategies:
//   • Static assets (_next/static, icons, fonts) → Cache First
//   • API responses → Network First with cache fallback
//   • Navigation requests → Network First with offline page fallback
//   • Images → Stale While Revalidate
// Background Sync:
//   • Queues failed POST/PUT/DELETE mutations for replay on reconnect
// Push Notifications:
//   • Displays push notifications from the backend
// ============================================================

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `bankerchanger-static-${CACHE_VERSION}`;
const API_CACHE = `bankerchanger-api-${CACHE_VERSION}`;
const IMAGE_CACHE = `bankerchanger-images-${CACHE_VERSION}`;
const OFFLINE_PAGE = '/offline';

const STATIC_ASSETS = [
  '/',
  '/offline',
  '/manifest.json',
];

const STATIC_PATTERNS = [
  /\/_next\/static\//,
  /\/icons\//,
  /\/fonts\//,
];

const API_PATTERNS = [
  /\/api\//,
];

const SYNC_TAG = 'bankerchanger-sync';

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate — clean up old cache versions ───────────────────────────────────
self.addEventListener('activate', (event) => {
  const knownCaches = [STATIC_CACHE, API_CACHE, IMAGE_CACHE];

  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('bankerchanger-') && !knownCaches.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests — they go through background sync instead.
  if (request.method !== 'GET') return;

  // Skip cross-origin requests except for the same API origin.
  if (url.origin !== self.location.origin && !API_PATTERNS.some((p) => p.test(url.pathname))) {
    return;
  }

  // Static assets — Cache First
  if (STATIC_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // API requests — Network First
  if (API_PATTERNS.some((p) => p.test(url.pathname))) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }

  // Image requests — Stale While Revalidate
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
    return;
  }

  // Navigation requests — Network First with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }
});

// ── Caching strategies ────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Resource unavailable offline', { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline — cached data unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'X-From-SW-Cache': 'miss' },
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });

  return cached ?? networkFetch;
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    const offlinePage = await caches.match(OFFLINE_PAGE);
    return offlinePage ?? new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
  }
}

// ── Message handler (e.g. SKIP_WAITING from update banner) ───────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Background Sync ───────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(replaySyncQueue());
  }
});

async function replaySyncQueue() {
  const db = await openSyncDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const all = await idbGetAll(store);

  for (const entry of all) {
    try {
      const response = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body ?? undefined,
      });

      if (response.ok) {
        store.delete(entry.id);
        broadcastSyncResult({ id: entry.id, status: 'synced', url: entry.url });
      } else if (response.status < 500) {
        // 4xx — permanent failure, remove from queue and notify
        store.delete(entry.id);
        broadcastSyncResult({ id: entry.id, status: 'failed', url: entry.url, statusCode: response.status });
      }
      // 5xx — keep in queue for next sync attempt
    } catch {
      // Network still unavailable — keep in queue
    }
  }

  await tx.done;
}

function broadcastSyncResult(payload) {
  self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => client.postMessage({ type: 'SYNC_RESULT', payload }));
  });
}

// ── Push Notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'BANKERCHANGER', body: event.data.text() };
  }

  const title = data.title ?? 'BANKERCHANGER';
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    tag: data.tag ?? 'bankerchanger-notification',
    data: data.data ?? {},
    actions: data.actions ?? [],
    requireInteraction: data.requireInteraction ?? false,
    silent: data.silent ?? false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url === url && 'focus' in c);
        if (existing) return existing.focus();
        return self.clients.openWindow(url);
      }),
  );
});

// ── IndexedDB helpers (no library dependency) ─────────────────────────────────
function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bankerchanger-sync', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        const store = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_url', 'url');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
