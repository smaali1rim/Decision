# Décisions — génération automatique du modèle « DECISION »

Application web qui remplit automatiquement le modèle Word **DECISION** et produit un fichier `.docx` prêt à signer.

## Fonctionnalités

| Élément du modèle | Automatisation |
|---|---|
| **Logo** | Image téléversée une fois dans *Paramètres*, insérée dans l’en-tête. |
| **DECISION N°** | Numéro incrémenté automatiquement à partir d’un numéro de départ configurable (format libre, ex. `{n}/{yyyy}`). |
| **OBJET** | Champ texte. |
| **Classement** | Compteur incrémenté automatiquement. |
| **Référence** | Compteur propre à chaque **classe** (ex. `RH-007`, `FIN-012`). |
| **Page X / Y** | Champs Word automatiques. |
| **Le Directeur du Complexe, (champ 1)** | Valeur par défaut dans *Paramètres*, modifiable par décision, reprise automatiquement à la signature. |
| **Vus** | Choix multiple depuis une bibliothèque + vus personnalisés, texte modifiable, ordre réglable. |
| **Articles** | Nombre libre, numérotés automatiquement (Article 1, 2, … n). |
| **Comité** | Liste déroulante des personnes : la fonction est remplie automatiquement ; désignation (Président, Membre, …) au choix ou saisie libre. |

Autres : aperçu A4 en direct, registre des décisions (recherche, ré-ouverture, modification, duplication, re-téléchargement), annuaire des personnes avec import copier-coller depuis Excel.

## Démarrage

Prérequis : Node.js 18 ou plus.

```bash
npm install
npm start
```

Puis ouvrir <http://localhost:3000>.

Variables d’environnement optionnelles :

- `PORT` — port HTTP (défaut `3000`)
- `DATA_DIR` — dossier des données (défaut `./data`)
- `APP_PASSWORD` — si défini, le site demande ce mot de passe (n’importe quel nom d’utilisateur)

### Avec Docker

```bash
docker build -t decisions .
docker run -d -p 3000:3000 -v decisions-data:/app/data --name decisions decisions
```

## Données

Tout est stocké dans `data/db.json` (+ le logo). **Sauvegardez ce dossier** : il contient les compteurs et le registre.

## Modifier la mise en page

- `templates/source/DECISION-maquette.docx` — la maquette d’origine.
- `templates/decision-template.docx` — le modèle utilisé par l’application, généré par `npm run build:template`.

Le modèle peut être retouché directement dans Word (polices, pied de page, marges…) à condition de conserver les balises :
`{logo}` `{numero}` `{objet}` `{classement}` `{reference}` `{complexe}`, les boucles `{#vus}{text}{/vus}`, `{#articles}…{/articles}`, `{#rest}{.}{/rest}`, `{#hasMembers}…{/hasMembers}` et `{#members}{nom} {fonction} {designation}{/members}`.
Attention : relancer `npm run build:template` écrase les retouches manuelles.

## Structure

```
server.js                 API Express + fichiers statiques
src/store.js              stockage JSON et compteurs
src/docx.js               remplissage du modèle Word (docxtemplater) + logo
scripts/build-template.js maquette d'origine -> modèle à balises
public/                   interface (HTML/CSS/JS sans build)
```
