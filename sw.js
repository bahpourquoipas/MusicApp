/* =========================================================================
   MusicApp — service worker : l'appli reste utilisable SANS RÉSEAU.

   Stratégie « copie locale d'abord, mise à jour en coulisse » :
   - Au premier chargement (avec réseau), la page et ses icônes sont copiées dans le cache de l'appareil.
   - Ensuite, chaque lancement sert cette copie : instantané, même sans réseau ni Wi-Fi capricieux de salle.
     En arrière-plan, si le réseau répond, on vérifie qu'il n'existe pas une version plus récente ;
     si oui, elle est mise de côté et l'appli PROPOSE de recharger. Jamais de rechargement automatique :
     un morceau en cours n'est jamais interrompu.
   - Une réponse qui n'est pas la vraie page (portail captif d'un hôtel, erreur 404, page tronquée) n'est JAMAIS
     enregistrée : la copie qui fonctionne reste en place.
   - Les adresses d'autres sites (Google Drive, par exemple) ne sont jamais interceptées.

   À placer à côté de index.html, sur la même adresse https. Les données (chansons, playlists) ne passent pas
   par ici : elles restent dans le stockage local de l'appareil.
   ========================================================================= */
'use strict';

const PREFIX = 'musicapp-shell-';
const CACHE = PREFIX + '1';                                   // changer ce numéro force un nouveau téléchargement complet
const APP_URL = new URL('index.html', self.location).href;    // la page, quel que soit le chemin de navigation demandé
const ASSET_URLS = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']
  .map(name => new URL(name, self.location).href);           // facultatifs : leur absence ne bloque pas l'installation
const APP_MARK = 'name="musicapp-shell"';                     // repère présent dans la vraie page (voir index.html)
const MSG = 'musicapp-sw';                                    // étiquette des messages envoyés à la page

// La réponse est-elle bien la page de l'appli ? (200, même origine, HTML, sans redirection, complète)
function isGenuineApp(response, text){
  if (!response || response.status !== 200 || response.redirected || response.type === 'opaque' || response.type === 'error') return false;
  const type = (response.headers && response.headers.get('content-type')) || '';
  return /text\/html/i.test(type) && text.indexOf(APP_MARK) !== -1 && /<\/html>\s*$/i.test(text);
}
function versionOf(text){
  const m = /name="musicapp-version"\s+content="([^"]+)"/.exec(text || '');
  return m ? m[1] : '';
}
function htmlResponse(text, original){
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  if (original && original.headers && original.headers.get('etag')) headers.set('ETag', original.headers.get('etag'));
  return new Response(text, { status: 200, headers });
}

// Télécharge la page directement sur le réseau (sans passer par le cache HTTP) et la vérifie.
async function fetchApp(){
  const res = await fetch(APP_URL, { cache: 'no-cache', credentials: 'same-origin' });
  const text = await res.text();
  if (!isGenuineApp(res, text)) throw new Error('réponse inattendue (' + res.status + ')');
  return { res, text };
}

async function notifyClients(message){
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  all.forEach(client => client.postMessage(Object.assign({ musicapp: MSG }, message)));
}

/* Compare avec la copie locale et la remplace si la page du serveur est différente.
   Résultat : 'updated' | 'current' | 'offline' | 'invalid' */
async function refreshApp(){
  let fresh;
  try {
    const res = await fetch(APP_URL, { cache: 'no-cache', credentials: 'same-origin' });
    const text = await res.text();
    fresh = { res, text };
  } catch (e) {
    return 'offline';
  }
  if (!isGenuineApp(fresh.res, fresh.text)) return 'invalid';
  const cache = await caches.open(CACHE);
  const old = await cache.match(APP_URL);
  const oldText = old ? await old.text() : null;
  if (oldText === fresh.text) return 'current';
  await cache.put(APP_URL, htmlResponse(fresh.text, fresh.res));
  if (oldText === null) return 'current';                        // aucune copie précédente : rien à annoncer
  await notifyClients({ event: 'update-ready', version: versionOf(fresh.text) });
  return 'updated';
}

async function cachedStatus(){
  const cache = await caches.open(CACHE);
  const hit = await cache.match(APP_URL);
  const text = hit ? await hit.text() : '';
  return { event: 'status', cache: CACHE, hasApp: !!hit, version: versionOf(text) };
}

const OFFLINE_PAGE = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>MusicApp</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0B0F;color:#F3F4F6;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px}'
  + 'b{color:#FFB648}</style></head><body><div><h1><b>MusicApp</b></h1><p>L\'appli n\'est pas encore enregistrée sur cet appareil.<br>Ouvrez-la une première fois avec une connexion Internet, puis elle fonctionnera sans réseau.</p></div></body></html>';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const { res, text } = await fetchApp();                   // page absente ou invalide : l'installation échoue, rien n'est à moitié en place
    const cache = await caches.open(CACHE);
    await cache.put(APP_URL, htmlResponse(text, res));
    await Promise.all(ASSET_URLS.map(async (url) => {
      try {
        const r = await fetch(url, { cache: 'reload' });
        if (r.ok && !r.redirected) await cache.put(url, r);
      } catch (e) { /* icône ou manifeste manquant : sans conséquence pour le fonctionnement */ }
    }));
    if (!self.registration.active) self.skipWaiting();         // toute première installation : on prend la main tout de suite
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.indexOf(PREFIX) === 0 && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
    await notifyClients(await cachedStatus().then(s => Object.assign(s, { event: 'ready' })));
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // Google Drive et autres sites : jamais touchés
  if (req.mode === 'navigate'){
    event.respondWith(serveApp(event));
  } else if (ASSET_URLS.indexOf(url.origin + url.pathname) !== -1){
    event.respondWith(serveAsset(req));
  }
});

async function serveApp(event){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(APP_URL);
  if (cached){
    event.waitUntil(refreshApp().catch(() => {}));            // vérification en coulisse, sans retarder l'affichage
    return cached;
  }
  try {                                                       // copie absente (cache vidé par le système) : on la reconstitue
    const { res, text } = await fetchApp();
    await cache.put(APP_URL, htmlResponse(text, res));
    return htmlResponse(text, res);
  } catch (e) {
    return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function serveAsset(req){
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && !res.redirected) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

// Messages de la page : état, vérification manuelle, activation d'une nouvelle version du service worker.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => { if (port) port.postMessage(payload); else if (event.source) event.source.postMessage(Object.assign({ musicapp: MSG }, payload)); };
  if (data.type === 'skip-waiting'){
    self.skipWaiting();
  } else if (data.type === 'status'){
    event.waitUntil(cachedStatus().then(reply).catch(() => reply({ event: 'status', hasApp: false })));
  } else if (data.type === 'check'){
    event.waitUntil(refreshApp().then(result => reply({ event: 'checked', result })).catch(() => reply({ event: 'checked', result: 'offline' })));
  }
});
