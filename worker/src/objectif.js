// ── OBJECTIF EN LANGAGE LIBRE ────────────────────────────────────────────────
// L'utilisateur écrit son objectif avec ses mots (ex : « rester à mon poids en
// perdant du gras »). L'app envoie ce texte et le profil (poids, taille, âge,
// sexe, dépense du jour). Claude en tire les calories, la répartition des
// macros et les règles de diète que l'app applique ensuite partout.
//
//   POST /objectif → { resume, ajustKcal, pctProt, pctGluc, pctLip, fib, regime, explication }

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

const Objectif = z.object({
  resume: z.string().describe('Nom court de l\'objectif, 2 à 4 mots, ex : « Recomposition », « Sèche douce ».'),
  ajustKcal: z.number().describe('Écart en kcal par jour par rapport à la dépense (TDEE) : négatif pour un déficit, positif pour un surplus, 0 pour le maintien.'),
  pctProt: z.number().describe('Part des calories venant des protéines, en %.'),
  pctGluc: z.number().describe('Part des calories venant des glucides, en %.'),
  pctLip: z.number().describe('Part des calories venant des lipides, en %.'),
  fib: z.number().describe('Fibres visées par jour, en grammes.'),
  regime: z.string().describe('Règles de diète concrètes pour choisir les repas, en une ou deux phrases, ex : « Riche en protéines, pauvre en matières grasses, peu de sucres rapides. »'),
  explication: z.string().describe('Deux ou trois phrases simples qui expliquent les chiffres à l\'utilisateur.'),
});

const SYSTEM = `Tu es le coach nutrition de CalTrack, une app de suivi calorique. L'utilisateur décrit son objectif avec ses propres mots. Tu le traduis en réglages chiffrés.
Règles :
- Base-toi sur les recommandations courantes en nutrition sportive. Exemples : recomposition corporelle (garder son poids en perdant du gras) → léger déficit de 0 à -250 kcal, protéines hautes (environ 2 g par kg de poids) ; sèche → déficit de -300 à -500 kcal ; prise de masse → surplus de +200 à +400 kcal.
- Les trois parts (protéines, glucides, lipides) font 100 %. Les lipides ne descendent pas sous 20 %.
- Reprends dans les règles de diète tout ce que l'utilisateur précise (aliments à éviter, pauvre en gras, etc.), y compris les règles déjà notées qui ne contredisent pas le nouvel objectif.
- Ne propose jamais un déficit de plus de 750 kcal ni moins de 1500 kcal par jour au total pour un homme, 1200 pour une femme.
- Écris simplement, en français, sans jargon.`;

export async function handleObjectif(request, env, cors, json) {
  if (request.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405, cors);
  if (!cors.ok) return json({ error: 'Origine non autorisée' }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête illisible' }, 400, cors); }
  const objectif = String(body.objectif || '').trim().slice(0, 1000);
  if (!objectif) return json({ error: 'Écris ton objectif d\'abord.' }, 400, cors);
  const p = body.profil || {};

  const texte = `<profil>
Sexe : ${p.sexe === 'F' ? 'femme' : 'homme'}, ${Math.round(p.age || 0)} ans, ${Math.round(p.poids || 0)} kg, ${Math.round(p.taille || 0)} cm
Dépense du jour (TDEE) : ${Math.round(p.tdee || 0)} kcal
</profil>

<objectif>
${objectif}
</objectif>

<regles_deja_notees>
${String(body.regime || 'aucune').slice(0, 1000)}
</regles_deja_notees>`;

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Clé Anthropic manquante côté serveur.' }, 500, cors);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Objectif) },
      system: SYSTEM,
      messages: [{ role: 'user', content: texte }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return json({ error: 'Impossible de traduire cet objectif, reformule-le.' }, 422, cors);
    }
    return json(response.parsed_output, 200, cors);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Trop de demandes, réessaie dans une minute.' }, 429, cors);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'Clé Anthropic invalide côté serveur.' }, 500, cors);
    if (err instanceof Anthropic.APIError) return json({ error: `Erreur du service IA (${err.status ?? 'réseau'}).` }, 502, cors);
    throw err;
  }
}
