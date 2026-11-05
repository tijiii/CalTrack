var CACHE = 'caltrack-v13';
var ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];
// Au-delà, on sert la copie gardée : en avion (wifi de bord lent), la page
// s'ouvre tout de suite au lieu d'attendre le réseau.
var NAV_TIMEOUT = 3000;

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

function keep(req, resp) {
  // Les polices Google arrivent parfois « opaques » (statut 0) : on les garde aussi
  if (resp && (resp.status === 200 || resp.type === 'opaque')) {
    var clone = resp.clone();
    caches.open(CACHE).then(function(c) { c.put(req, clone); });
  }
  return resp;
}

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  if (e.request.method !== 'GET') return;

  // Ne jamais intercepter les appels au Worker Cloudflare ou à Open Food Facts
  if (url.indexOf('workers.dev') >= 0 || url.indexOf('openfoodfacts') >= 0) return;

  // Polices (Garamond) : la copie gardée d'abord, mise à jour en arrière-plan,
  // pour garder la même typo sans réseau
  if (url.indexOf('fonts.googleapis.com') >= 0 || url.indexOf('fonts.gstatic.com') >= 0) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        var fresh = fetch(e.request).then(function(resp) { return keep(e.request, resp); }).catch(function() { return cached; });
        return cached || fresh;
      })
    );
    return;
  }

  // Page : le réseau d'abord pour avoir la dernière version, mais pas plus de
  // NAV_TIMEOUT ; sans réponse, la copie gardée
  if (e.request.mode === 'navigate' || url.indexOf('index.html') >= 0) {
    e.respondWith(new Promise(function(resolve) {
      var done = false;
      function fallback() {
        if (done) return;
        caches.match(e.request).then(function(c) { return c || caches.match('./index.html'); }).then(function(c) {
          if (c && !done) { done = true; resolve(c); }
        });
      }
      var timer = setTimeout(fallback, NAV_TIMEOUT);
      fetch(e.request).then(function(resp) {
        keep(e.request, resp);
        clearTimeout(timer);
        if (!done) { done = true; resolve(resp); }
      }).catch(function() {
        clearTimeout(timer);
        fallback();
        // rien en cache non plus : laisser le navigateur afficher son erreur
        setTimeout(function() { if (!done) { done = true; resolve(Response.error()); } }, 1000);
      });
    }));
    return;
  }

  // Cache-first pour les autres fichiers locaux
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(resp) { return keep(e.request, resp); })
        .catch(function() { return caches.match('./index.html'); });
    })
  );
});
