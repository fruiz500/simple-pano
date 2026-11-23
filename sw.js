/* Simple Pano service worker: lets the app install to the Home Screen and run without Internet.
 *
 * Every file of the app is kept on the device. When there is a connection, the newest copy from the server is used (and kept
 * for next time), so updates arrive by themselves; when there is none, or the server is slow, the kept copy is used.
 * Only files of this app are handled; calls to AI services and other sites go straight to the network.
 * Free software, GPL-3.0-or-later.
 */
'use strict';
const CACHE = 'simple-pano';
const WAIT_MS = 4000;                       // how long to wait for the server before using the kept copy
const FILES = [
    './', 'index.html', 'help.html', 'manifest.webmanifest',
    'pano.css', 'pano_shoot.css', 'pano_app.js', 'pano_shoot.js', 'pano_align.js', 'pano_features.js', 'pano_seams.js', 'stitch_ai.js',
    'vendor/three.min.js', 'vendor/DeviceOrientationControls.js', 'vendor/exifr.lite.umd.js',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];
const keyOf = url => { const u = new URL(url, self.location); return u.origin + u.pathname; };      // the ?v= numbers do not matter

self.addEventListener('install', e => {
    e.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await Promise.all(FILES.map(async f => {
            try { const r = await fetch(new Request(f, { cache: 'reload' })); if (r.ok) await cache.put(keyOf(f), r); } catch (err) { /* offline now: it is kept the first time it is used */ }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', e => {
    const req = e.request, url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
    e.respondWith((async () => {
        const cache = await caches.open(CACHE), key = keyOf(req.url);
        const net = fetch(req, { cache: 'no-cache' }).then(async r => { if (r.ok && r.type === 'basic') await cache.put(key, r.clone()); return r; });
        e.waitUntil(net.catch(() => { }));
        let kept = await cache.match(key);
        if (!kept && req.mode === 'navigate') kept = await cache.match(keyOf('index.html')) || await cache.match(keyOf('./'));
        if (!kept) return net;                                                             // first visit: wait for the server
        const r = await Promise.race([net.catch(() => null), new Promise(res => setTimeout(() => res(null), WAIT_MS))]);
        return r || kept;
    })());
});
