// ── IDÉES DE RECETTES ────────────────────────────────────────────────────────
// L'app envoie ce qu'il reste à manger aujourd'hui, la répartition des macros
// visée par le profil (stratégie) et les règles de diète écrites par
// l'utilisateur (ex : « pauvre en matières grasses »). Claude propose des
// recettes qui respectent ces règles, avec ou sans courses en plus.
//
//   POST /recettes → { avec_stock: [...], avec_courses: [...] }

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

const Recette = z.object({
  nom: z.string(),
  temps: z.string().describe('Temps de préparation, ex : « 20 min ».'),
  ingredients: z.array(z.string()).describe('Ingrédients avec leur quantité, ex : « 150 g de blanc de poulet ».'),
  a_acheter: z.array(z.string()).describe('Ingrédients à acheter en plus de ce qui est disponible, nom simple. Vide si rien à acheter.'),
  instructions: z.string().describe('Deux ou trois phrases courtes.'),
  kcal: z.number(),
  prot: z.number().describe('Protéines en grammes.'),
  gluc: z.number().describe('Glucides en grammes.'),
  lip: z.number().describe('Lipides en grammes.'),
  fib: z.number().describe('Fibres en grammes.'),
});

const Suggestions = z.object({
  avec_stock: z.array(Recette).describe('Recettes faites uniquement avec les ingrédients disponibles (plus sel, poivre, épices, huile en filet). Vide si aucun ingrédient n\'est donné.'),
  avec_courses: z.array(Recette).describe('Recettes qui demandent quelques courses en plus.'),
});

const SYSTEM = `Tu es le coach nutrition de CalTrack, une app de suivi calorique. Tu proposes des idées de recettes pour un repas.
Règles :
- Les règles de diète de l'utilisateur passent avant tout. Si une recette ne les respecte pas, ne la propose pas. Exemple : pour une diète pauvre en matières grasses, pas de carbonara, crème, fromage gras, charcuterie, friture ou sauce au beurre ; préfère viandes maigres, poisson blanc, légumes, féculents, laitages 0 %, cuisson vapeur, four ou poêle antiadhésive.
- Chaque recette doit suivre la répartition des macros visée : la part des calories venant des lipides (lipides × 9 / kcal) ne doit pas dépasser la part visée ; protéines au moins à la part visée.
- Une recette est un repas : elle tient dans le budget restant du jour sans le dépasser.
- Respecte le temps de préparation maximum.
- Propose 2 à 3 recettes avec les ingrédients disponibles (si l'utilisateur en donne) et 3 recettes avec quelques courses en plus.
- Cuisine simple et réaliste, ingrédients faciles à trouver en supermarché en France, plats variés.
- Les valeurs nutritionnelles sont celles du repas entier, calculées à partir des quantités crues des ingrédients.`;

const pct = v => Math.round(Number(v) || 0);

export async function handleRecettes(request, env, cors, json) {
  if (request.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405, cors);
  if (!cors.ok) return json({ error: 'Origine non autorisée' }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête illisible' }, 400, cors); }
  const b = body.budget || {};
  const r = body.repartition || {};

  const texte = `<budget_restant_aujourd_hui>
${Math.round(b.kcal || 0)} kcal, ${Math.round(b.prot || 0)} g protéines, ${Math.round(b.gluc || 0)} g glucides, ${Math.round(b.lip || 0)} g lipides
</budget_restant_aujourd_hui>

Stratégie : ${String(body.strategie || 'Maintien').slice(0, 60)}
Répartition visée des calories : ${pct(r.prot)} % protéines, ${pct(r.gluc)} % glucides, ${pct(r.lip)} % lipides maximum
Temps de préparation maximum : ${String(body.prepTime || '30 minutes').slice(0, 30)}

<regles_de_diete>
${String(body.regime || 'aucune règle en plus').slice(0, 1000)}
</regles_de_diete>

<ingredients_disponibles>
${String(body.ingredients || 'aucun, idées libres').slice(0, 1000)}
</ingredients_disponibles>`;

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Clé Anthropic manquante côté serveur.' }, 500, cors);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Suggestions) },
      system: SYSTEM,
      messages: [{ role: 'user', content: texte }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return json({ error: 'Impossible de proposer des recettes, réessaie.' }, 422, cors);
    }
    return json(response.parsed_output, 200, cors);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Trop de demandes, réessaie dans une minute.' }, 429, cors);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'Clé Anthropic invalide côté serveur.' }, 500, cors);
    if (err instanceof Anthropic.APIError) return json({ error: `Erreur du service IA (${err.status ?? 'réseau'}).` }, 502, cors);
    throw err;
  }
}
