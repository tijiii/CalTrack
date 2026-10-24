// ── SYNCHRO CALTRACK ─────────────────────────────────────────────────────────
// Petit serveur (Cloudflare Worker) qui garde la base de CalTrack (profil,
// journal, historique, aliments perso, favoris, mémoire IA) dans Cloudflare KV
// (binding CALTRACK), pour la retrouver sur tous tes appareils.
//
//   GET /store/db → { rev, data, updatedAt } (ou null si la base est vide)
//   PUT /store/db   corps { baseRev, data } → { ok, rev }
//                   409 { error, rev, data } si un autre appareil a écrit entre-temps
//   POST /plan    → plan de repas et liste de courses (voir plan.js)
//
// Le site passe par son origine (ALLOWED_ORIGINS).

import { handlePlan } from './plan.js';

const DB_KEY = 'db';
const BACKUP_DAYS = 30;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://tijiii.github.io').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || allowed.includes('*');
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    ok,
  };
}

function reply(body, status, cors) {
  const { ok, ...headers } = cors;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function newRev() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function handleStore(request, env, url) {
  const cors = corsHeaders(request.headers.get('Origin') || '', env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: (({ ok, ...h }) => h)(cors) });
  if (!cors.ok) return reply({ error: 'Origine non autorisée' }, 403, cors);

  const parts = url.pathname.split('/').filter(Boolean).slice(1); // sans « store »
  if (parts[0] !== 'db') return reply({ error: 'Introuvable' }, 404, cors);

  if (request.method === 'GET') {
    return reply((await env.CALTRACK.get(DB_KEY)) || 'null', 200, cors);
  }

  if (request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return reply({ error: 'Base trop lourde' }, 413, cors);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Base illisible' }, 400, cors); }
    const data = body && body.data;
    if (!data || typeof data.state !== 'object' || !data.state) return reply({ error: 'Base incomplète' }, 400, cors);

    const current = await env.CALTRACK.get(DB_KEY, 'json');
    // Un autre appareil a écrit depuis la dernière lecture : on renvoie sa
    // version au lieu de l'écraser.
    if (current && current.rev !== body.baseRev) {
      return reply({ error: 'Modifié sur un autre appareil', rev: current.rev, data: current.data }, 409, cors);
    }
    if (current) {
      const backupKey = `backup:${new Date().toISOString().slice(0, 13)}`;
      if (!(await env.CALTRACK.get(backupKey))) {
        await env.CALTRACK.put(backupKey, JSON.stringify(current), { expirationTtl: BACKUP_DAYS * 86400 });
      }
    }
    const rev = newRev();
    await env.CALTRACK.put(DB_KEY, JSON.stringify({ rev, data, updatedAt: new Date().toISOString() }));
    return reply({ ok: true, rev }, 200, cors);
  }

  return reply({ error: 'Méthode non autorisée' }, 405, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/store' || url.pathname.startsWith('/store/')) return handleStore(request, env, url);
    if (url.pathname === '/plan') {
      const cors = corsHeaders(request.headers.get('Origin') || '', env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: (({ ok, ...h }) => h)(cors) });
      return handlePlan(request, env, cors, reply);
    }
    return new Response('Introuvable', { status: 404 });
  },
};
