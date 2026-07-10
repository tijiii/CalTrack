var CACHE = 'caltrack-v4';
var ASSETS = ['./index.html', './manifest.json'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  
  // Ne jamais intercepter les appels au Worker Cloudflare ou API externes
  if (url.indexOf('workers.dev') >= 0 || url.indexOf('openfoodfacts') >= 0 || url.indexOf('fonts.googleapis') >= 0) {
    return;
  }
  
  // Network-first pour index.html : toujours la dernière version si le réseau répond
  if (e.request.mode === 'navigate' || url.indexOf('index.html') >= 0) {
    e.respondWith(
      fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return resp;
      }).catch(function() { return caches.match(e.request).then(function(c) { return c || caches.match('./index.html'); }); })
    );
    return;
  }

  // Cache-first pour les autres assets locaux
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return resp;
      }).catch(function() { return caches.match('./index.html'); });
    })
  );
});
