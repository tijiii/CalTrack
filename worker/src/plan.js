// ── PLAN DE REPAS ET LISTE DE COURSES ────────────────────────────────────────
// L'app envoie les objectifs du profil (calories et macros par jour, ce qu'il
// reste aujourd'hui), les repas voulus, le temps dispo et ce qu'il y a déjà au
// frigo. Claude compose les repas de chaque jour pour coller aux objectifs et
// en tire la liste de courses. La clé Anthropic reste ici (secret ANTHROPIC_API_KEY).
//
//   POST /plan → { jours: [...], courses: [...], remarque }

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

const Ingredient = z.object({
  nom: z.string().describe('Nom simple de l\'ingrédient, ex : « blanc de poulet », « riz basmati ».'),
  quantite: z.string().describe('Quantité pour ce repas, telle qu\'on la pèse ou la compte, ex : « 120 g », « 2 », « 1 c. à soupe ».'),
  pesee: z.enum(['cru', 'cuit', 'tel quel']).describe('État dans lequel on pèse la quantité. « cru » pour tout ce qui change de poids en cuisant (pâtes, riz, semoule, lentilles, viande, poisson, légumes cuits) : pesé avant cuisson. « cuit » seulement si l\'ingrédient est déjà cuit au départ (ex : reste de riz cuit). « tel quel » pour ce qui ne cuit pas ou se compte (huile, épices, yaourt, fromage blanc, oeufs, fruits).'),
  equivalent: z.string().describe('Pour un ingrédient pesé cru qui change de poids en cuisant, son poids approximatif une fois cuit, ex : « ≈ 300 g une fois cuites ». Vide sinon.'),
});

const Repas = z.object({
  moment: z.string().describe('Un des moments demandés, ex : « Déjeuner ».'),
  nom: z.string(),
  temps: z.string().describe('Temps de préparation, ex : « 20 min ».'),
  ingredients: z.array(Ingredient),
  instructions: z.string().describe('Résumé du plat en une phrase.'),
  etapes: z.array(z.string()).describe('Toutes les étapes de préparation dans l\'ordre, une action par étape, assez détaillées pour un débutant : quelle quantité utiliser, découpe, feu ou température, temps de cuisson et comment savoir que c\'est prêt.'),
  kcal: z.number(),
  prot: z.number().describe('Protéines en grammes.'),
  gluc: z.number().describe('Glucides en grammes.'),
  lip: z.number().describe('Lipides en grammes.'),
  fib: z.number().describe('Fibres en grammes.'),
});

const Jour = z.object({
  jour: z.string().describe('Le jour tel qu\'il est donné, ex : « Mardi ».'),
  repas: z.array(Repas),
});

const Course = z.object({
  nom: z.string(),
  quantite: z.string().describe('Quantité totale à acheter pour tout le plan, ex : « 600 g », « 12 », « 1 pot ».'),
  rayon: z.enum(['Fruits & légumes', 'Viandes & poissons', 'Crèmerie & oeufs', 'Féculents & céréales', 'Épicerie', 'Surgelés', 'Boissons', 'Autre']),
});

const Plan = z.object({
  jours: z.array(Jour),
  courses: z.array(Course).describe('Tout ce qu\'il faut acheter pour le plan, ingrédients regroupés et additionnés, sans ce qui est déjà en stock.'),
  remarque: z.string().describe('Une phrase courte pour l\'utilisateur si un objectif n\'a pas pu être tenu. Vide sinon.'),
});

const SYSTEM = `Tu es le coach nutrition de CalTrack, une app de suivi calorique. Tu prépares un plan de repas pour plusieurs jours et la liste de courses qui va avec.
Règles :
- Pour chaque jour, les repas additionnés doivent coller à l'objectif du jour : calories à ±5 %, protéines au moins à l'objectif, glucides et lipides proches.
- Un jour marqué « déjà commencé » n'a qu'un budget restant : propose seulement les repas qui le remplissent, et aucun si le budget est presque nul.
- Les règles de diète passent avant tout : un repas qui ne les respecte pas n'a pas sa place dans le plan (ex : pauvre en matières grasses → pas de carbonara, crème, fromage gras, charcuterie ni friture).
- Respecte le temps de préparation maximum, les préférences et les aliments à éviter.
- Cuisine simple et réaliste, ingrédients faciles à trouver en supermarché en France. Réutilise les mêmes ingrédients d'un jour à l'autre pour limiter les courses et le gaspillage, sans servir deux fois le même plat dans le plan.
- Utilise en priorité ce que l'utilisateur a déjà en stock, et ne le mets pas dans la liste de courses.
- Chaque quantité précise si elle se pèse crue ou cuite. Par défaut, pèse cru tout ce qui cuit (120 g de pâtes = 120 g de pâtes crues) et donne alors l'équivalent cuit.
- Les étapes de préparation sont complètes et détaillées : quelqu'un qui n'a jamais fait le plat doit pouvoir le réussir sans rien chercher ailleurs.
- Les valeurs nutritionnelles sont celles du repas entier, calculées à partir des quantités crues des ingrédients.`;

export async function handlePlan(request, env, cors, json) {
  if (request.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405, cors);
  if (!cors.ok) return json({ error: 'Origine non autorisée' }, 403, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Requête illisible' }, 400, cors); }
  const jours = Array.isArray(body.jours) ? body.jours.slice(0, 7) : [];
  const moments = Array.isArray(body.moments) ? body.moments.slice(0, 6).map(String) : [];
  if (!jours.length || !moments.length) return json({ error: 'Choisis au moins un jour et un repas.' }, 400, cors);

  const lignes = jours.map(j => {
    const debut = j.commence ? ' (déjà commencé, budget restant)' : '';
    return `- ${String(j.jour)}${debut} : ${Math.round(j.kcal)} kcal, ${Math.round(j.prot)} g protéines, ${Math.round(j.gluc)} g glucides, ${Math.round(j.lip)} g lipides`;
  }).join('\n');
  const texte = `<objectifs_par_jour>
${lignes}
</objectifs_par_jour>

Stratégie : ${String(body.strategie || 'Maintien').slice(0, 60)}
Règles de diète (à respecter pour chaque repas) : ${String(body.regime || 'aucune').slice(0, 1000)}
Repas à prévoir chaque jour : ${moments.join(', ')}
Temps de préparation maximum par repas : ${String(body.tempsMax || '30 minutes').slice(0, 30)}

<preferences>
${String(body.preferences || 'aucune').slice(0, 1000)}
</preferences>

<deja_en_stock>
${String(body.stock || 'rien de particulier').slice(0, 1000)}
</deja_en_stock>`;

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Clé Anthropic manquante côté serveur.' }, 500, cors);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(Plan) },
      system: SYSTEM,
      messages: [{ role: 'user', content: texte }],
    }, { timeout: 10 * 60 * 1000 }); // plan long avec étapes détaillées : au-delà de ~21k jetons le SDK exige un délai explicite
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return json({ error: 'Impossible de préparer ce plan, réessaie.' }, 422, cors);
    }
    return json(response.parsed_output, 200, cors);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Trop de demandes, réessaie dans une minute.' }, 429, cors);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'Clé Anthropic invalide côté serveur.' }, 500, cors);
    if (err instanceof Anthropic.APIError) return json({ error: `Erreur du service IA (${err.status ?? 'réseau'}).` }, 502, cors);
    throw err;
  }
}
