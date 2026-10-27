// ── RECHERCHE D'ALIMENTS DE MARQUE ───────────────────────────────────────────
// Cherche dans Open Food Facts (plus de 3 millions de produits, toutes les
// marques du commerce) pour la recherche du journal, ex : « avoine chocolat
// bjorg ». Deux moteurs sont interrogés en même temps :
//   - search.openfoodfacts.org, le nouveau moteur, rapide et tolérant aux fautes ;
//   - l'ancienne recherche de world.openfoodfacts.org, plus lente mais qui
//     complète quand le premier rate un produit.
// Les résultats sont fusionnés, classés selon les mots tapés (nom + marque),
// et gardés en cache une journée pour répondre tout de suite la fois suivante.
//
//   GET /aliments?q=avoine chocolat bjorg → { produits: [{ nom, marque, kcal, prot, gluc, fib, lip, ... }] }

const UA = 'CalTrack/1.0 (https://tijiii.github.io)';
const TIMEOUT_MS = 6000;
const CACHE_TTL = 86400;
const MAX_RESULTS = 20;
const FIELDS = 'code,product_name,product_name_fr,generic_name_fr,brands,quantity,serving_size,nutriments,countries_tags';

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Les champs n'ont pas toujours la même forme selon le moteur : texte, liste,
// ou texte par langue ({ fr, main, ... }).
function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
  if (typeof v === 'object') return text(v.fr || v.main || Object.values(v)[0]);
  return String(v).trim();
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function kcalOf(n) {
  if (num(n['energy-kcal_100g']) > 0) return num(n['energy-kcal_100g']);
  if (num(n['energy_100g']) > 0) return num(n['energy_100g']) / 4.184; // kJ
  return 0;
}

function toProduit(p) {
  const n = p.nutriments || {};
  const nom = text(p.product_name_fr) || text(p.product_name) || text(p.generic_name_fr);
  const kcal = kcalOf(n);
  if (!nom || kcal <= 0) return null;
  const r1 = x => Math.round(num(x) * 10) / 10;
  const portion = parseFloat(text(p.serving_size));
  return {
    code: text(p.code),
    nom,
    marque: text(p.brands).split(',')[0].trim(),
    quantite: text(p.quantity),
    kcal: Math.round(kcal),
    prot: r1(n.proteins_100g),
    gluc: r1(n.carbohydrates_100g),
    fib: r1(n.fiber_100g),
    lip: r1(n.fat_100g),
    portionG: /g\b/i.test(text(p.serving_size)) && portion > 0 ? portion : null,
    france: (p.countries_tags || []).includes('en:france'),
  };
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Open Food Facts ${res.status}`);
  return res.json();
}

async function searchNew(q, signal) {
  const base = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&langs=fr`;
  let data;
  try {
    data = await fetchJson(`${base}&page_size=40&fields=${FIELDS}`, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    // Si le moteur refuse la liste de champs, on prend les fiches complètes.
    data = await fetchJson(`${base}&page_size=20`, signal);
  }
  return data.hits || [];
}

async function searchOld(q, signal) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=40&lc=fr&fields=${FIELDS}`;
  const data = await fetchJson(url, signal);
  return data.products || [];
}

// Plus il y a de mots tapés retrouvés dans le nom et la marque, plus le produit
// remonte ; à égalité, les produits vendus en France passent devant.
function rank(produits, q) {
  const mots = normalize(q).split(' ').filter(m => m.length > 1);
  return produits
    .map((p, i) => {
      const nom = normalize(p.nom);
      const marque = normalize(p.marque);
      let score = 0;
      for (const m of mots) {
        if (marque.split(' ').includes(m)) score += 3;
        else if (nom.split(' ').some(w => w.startsWith(m))) score += 2;
        else if ((nom + ' ' + marque).includes(m)) score += 1;
      }
      if (p.france) score += 0.5;
      return { p, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.p);
}

export async function searchAliments(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const results = await Promise.allSettled([searchNew(q, ctrl.signal), searchOld(q, ctrl.signal)]);
  clearTimeout(timer);
  const seen = new Set();
  const produits = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const raw of r.value) {
      const p = toProduit(raw);
      if (!p) continue;
      const key = p.code || normalize(p.nom + ' ' + p.marque);
      if (seen.has(key)) continue;
      seen.add(key);
      produits.push(p);
    }
  }
  const ok = results.some(r => r.status === 'fulfilled');
  return { ok, produits: rank(produits, q).slice(0, MAX_RESULTS) };
}

export async function handleAliments(request, env, cors, json) {
  if (request.method !== 'GET') return json({ error: 'Méthode non autorisée' }, 405, cors);
  if (!cors.ok) return json({ error: 'Origine non autorisée' }, 403, cors);

  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 100);
  if (q.length < 2) return json({ produits: [] }, 200, cors);

  const cache = caches.default;
  const cacheKey = new Request(`https://caltrack-cache/aliments?q=${encodeURIComponent(normalize(q))}`);
  const cached = await cache.match(cacheKey);
  if (cached) return json(await cached.text(), 200, cors);

  const { ok, produits } = await searchAliments(q);
  if (!ok) return json({ error: 'Open Food Facts ne répond pas, réessaie.' }, 502, cors);
  const body = JSON.stringify({ produits });
  if (produits.length) {
    await cache.put(cacheKey, new Response(body, { headers: { 'Cache-Control': `max-age=${CACHE_TTL}` } }));
  }
  return json(body, 200, cors);
}
