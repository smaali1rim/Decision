# Enrichissement des abonnés (Firecrawl)

Complète un CSV `email + nom` avec : nom de l'activité, site pro, métier, spécialisation,
année de lancement, clientèle, offres, liens des comptes pro, newsletter/média, réseaux sociaux.

## Installation

```bash
pip install requests
export FIRECRAWL_API_KEY=fc-xxxxxxxx   # clé sur https://firecrawl.dev
```

## Utilisation

```bash
python enrich.py abonnes.csv -o abonnes_enrichis.csv --limit 5   # test sur 5 lignes
python enrich.py abonnes.csv -o abonnes_enrichis.csv             # liste complète
```

- Colonnes détectées automatiquement (`Email`, `Nom`, ou `Prénom` + `Nom`) ; sinon `--email-col` / `--name-col`.
- Séparateur `,` ou `;` détecté. Sortie en `;` + UTF-8 BOM (s'ouvre directement dans Excel).
- Reprenable : les contacts traités sont en cache dans `.cache_enrichissement/`.
- `--max-scrapes 1` réduit la consommation de crédits.

## Fonctionnement

1. Email sur un domaine pro (`@mon-cabinet.fr`) → ce domaine est scrapé directement (confiance **haute**).
2. Sinon recherche Firecrawl `"Prénom Nom"` ; les annuaires/réseaux sont écartés comme « site »,
   les résultats mentionnant le nom sont priorisés (confiance **moyenne**).
3. Scrape avec extraction JSON (schéma dans `enrich.py`) + liste des liens de la page.
   Le modèle confirme si la page correspond bien à la personne.
4. Réseaux sociaux et outils de newsletter (Substack, Brevo, Mailchimp, Kit, Beehiiv…)
   détectés dans les liens de la page et de la recherche.
5. Année de lancement : le site, sinon l'API publique
   [Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr) via le SIREN des mentions légales.

Coût indicatif : 1 recherche + 1 à 2 scrapes avec extraction JSON par contact.
Vérifiez la grille de crédits Firecrawl actuelle avant de lancer une grosse liste.

**Relisez les lignes `moyenne` / `faible`** : les homonymes sont la principale source d'erreur.

## RGPD

Enrichir les données d'abonnés est un traitement de données personnelles : base légale
(intérêt légitime documenté), information des personnes (art. 14, sous un mois),
droit d'opposition, et uniquement des données professionnelles publiques.
