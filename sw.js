// ═══════════════════════════════════════════════════════════════════════════════
// NEXUS CHAT — Service Worker v1
// Progressive Web App Support & Offline Caching
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'nexus-v1';
const CACHE_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/logo.png',
    '/sw.js'
];

// ─── INSTALL EVENT ────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => {
                console.log('[Service Worker] Caching app shell');
                return cache.addAll(CACHE_ASSETS).catch(() => {
                    console.log('[Service Worker] Some assets failed to cache (expected for network)');
                });
            })
            .then(() => self.skipWaiting())
    );
});

// ─── ACTIVATE EVENT ───────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((cacheName) => cacheName !== CACHE_VERSION)
                        .map((cacheName) => {
                            console.log('[Service Worker] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

// ─── FETCH EVENT ──────────────────────────────────────────────────────────────
// Strategy: Network First, Cache Fallback
// This allows real-time updates while providing offline access
self.addEventListener('fetch', (event) => {
    const { request } = event;
    
    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }
    
    // Skip cross-origin requests
    if (!request.url.startsWith(self.location.origin)) {
        return;
    }
    
    // Network-first strategy
    event.respondWith(
        fetch(request)
            .then((response) => {
                // Cache successful responses
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => {
                        cache.put(request, clone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fall back to cache
                return caches.match(request)
                    .then((cached) => {
                        if (cached) {
                            return cached;
                        }
                        
                        // Return offline page if available
                        if (request.destination === 'document') {
                            return caches.match('/index.html');
                        }
                        
                        return new Response('Offline - Resource not available', {
                            status: 503,
                            statusText: 'Service Unavailable',
                            headers: new Headers({
                                'Content-Type': 'text/plain'
                            })
                        });
                    });
            })
    );
});

// ─── MESSAGE EVENT (for skip waiting) ──────────────────────────────────────────
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ─── PUSH NOTIFICATION EVENT ──────────────────────────────────────────────────
self.addEventListener('push', (event) => {
    console.log('[Service Worker] Push notification received');
    
    const options = {
        body: event.data ? event.data.text() : 'New message',
        icon: '/logo.png',
        badge: '/logo.png',
        tag: 'nexus-chat',
        requireInteraction: false,
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        }
    };
    
    event.waitUntil(
        self.registration.showNotification('Nexus Chat', options)
    );
});

// ─── NOTIFICATION CLICK EVENT ─────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    console.log('[Service Worker] Notification clicked');
    event.notification.close();
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // Focus existing window
                for (const client of clientList) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }
                // Open new window if none exist
                if (clients.openWindow) {
                    return clients.openWindow('/');
                }
            })
    );
});

// ─── BACKGROUND SYNC (optional) ────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-messages') {
        event.waitUntil(syncMessages());
    }
});

async function syncMessages() {
    console.log('[Service Worker] Syncing messages...');
    // Implement message sync logic here
}

console.log('[Service Worker] Loaded and ready');
