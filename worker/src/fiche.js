// ── FICHE RECETTE DÉTAILLÉE ──────────────────────────────────────────────────
// Transforme une recette courte (nom, ingrédients, quelques phrases) en vraie
// fiche de cuisine : matériel, ingrédients regroupés, étapes détaillées avec
// temps, températures et repères visuels, astuces, variantes et conservation.
// Les ingrédients et leurs quantités restent ceux de la recette, pour que les
// calories et macros déjà calculées restent justes.
//
//   POST /fiche → { intro, temps_preparation, temps_cuisson, difficulte, materiel, ingredients, etapes, astuces, variantes, conservation }

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

const Ingredient = z.object({
  groupe: z.string().describe('Partie de la recette, ex : « Pour la sauce », « Pour servir ». Vide s\'il n\'y a qu\'un seul groupe.'),
  nom: z.string(),
  quantite: z.string().describe('Quantité pour la recette, ex : « 150 g », « 1 c. à soupe ».'),
  pesee: z.enum(['cru', 'cuit', '']).describe('« cru » si la quantité se pèse avant cuisson, « cuit » si elle se pèse cuite, vide si sans objet.'),
  equivalent: z.string().describe('Repère utile, ex : « ≈ 200 g une fois cuit », « 1 gousse moyenne ». Vide sinon.'),
});

const Etape = z.object({
  titre: z.string().describe('Titre court de l\'étape, ex : « Cuire le riz ».'),
  detail: z.string().describe('Trois à cinq phrases précises : gestes, feu ou température, durée, repères visuels ou de texture pour savoir que c\'est prêt.'),
  duree: z.string().describe('Durée de l\'étape, ex : « 10 min ». Vide si instantané.'),
});

const Fiche = z.object({
  intro: z.string().describe('Deux ou trois phrases qui présentent le plat et pourquoi il colle à la diète.'),
  temps_preparation: z.string(),
  temps_cuisson: z.string(),
  difficulte: z.enum(['Facile', 'Moyenne', 'Difficile']),
  materiel: z.array(z.string()).describe('Ustensiles nécessaires.'),
  ingredients: z.array(Ingredient),
  etapes: z.array(Etape).describe('Toutes les étapes, de la mise en place au dressage.'),
  astuces: z.array(z.string()).describe('Deux à quatre conseils de chef pour réussir le plat.'),
  variantes: z.array(z.string()).describe('Deux ou trois variantes qui respectent la diète.'),
  conservation: z.string().describe('Comment et combien de temps garder le plat, et comment le réchauffer.'),
});

const SYSTEM = `Tu es le chef de CalTrack, une app de suivi calorique. On te donne une recette courte ; tu en écris la fiche complète, comme dans un bon livre de cuisine, pour qu'un débutant la réussisse du premier coup.
Règles :
- Garde exactement les ingrédients et les quantités donnés : les calories et macros de la recette en dépendent. Sel, poivre, eau et épices peuvent s'ajouter sans quantité.
- Étapes détaillées et concrètes : mise en place, températures du four ou intensité du feu, durées, repères visuels ou de texture. Pas de jargon sans explication.
- Respecte les règles de diète : astuces et variantes comprises.
- Recette pour 1 personne, en français simple.`;

export async function handleFiche(request, env, cors, json) {
  if (request.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405, cors);
  if (!cors.ok) return json({ error: 'Origine non autorisée' }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête illisible' }, 400, cors); }
  const r = body.recette || {};
  if (!r.nom) return json({ error: 'Recette manquante' }, 400, cors);
  const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, 40)
    .map(i => typeof i === 'string' ? `- ${i}` : `- ${i.quantite || ''} ${i.nom || ''}${i.pesee ? ` (pesé ${i.pesee})` : ''}`.replace(/\s+/g, ' '))
    .join('\n');
  const etapes = (Array.isArray(r.etapes) ? r.etapes : []).slice(0, 20).map((e, n) => `${n + 1}. ${e}`).join('\n');

  const texte = `<recette>
Nom : ${String(r.nom).slice(0, 120)}
Temps indiqué : ${String(r.temps || 'non précisé').slice(0, 30)}
Valeurs pour le plat : ${Math.round(r.kcal || 0)} kcal, ${Math.round(r.prot || 0)} g protéines, ${Math.round(r.gluc || 0)} g glucides, ${Math.round(r.lip || 0)} g lipides

Ingrédients :
${ingredients || 'non précisés'}

Instructions :
${String(r.instructions || '').slice(0, 1500)}
${etapes}
</recette>

<regles_de_diete>
${String(body.regime || 'aucune règle en plus').slice(0, 1000)}
</regles_de_diete>`;

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Clé Anthropic manquante côté serveur.' }, 500, cors);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Fiche) },
      system: SYSTEM,
      messages: [{ role: 'user', content: texte }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return json({ error: 'Impossible de détailler cette recette, réessaie.' }, 422, cors);
    }
    return json(response.parsed_output, 200, cors);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Trop de demandes, réessaie dans une minute.' }, 429, cors);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'Clé Anthropic invalide côté serveur.' }, 500, cors);
    if (err instanceof Anthropic.APIError) return json({ error: `Erreur du service IA (${err.status ?? 'réseau'}).` }, 502, cors);
    throw err;
  }
}
