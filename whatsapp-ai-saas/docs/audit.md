# Audit WaCopilote 1.49

Audit de code réalisé le 26 novembre 2026 sur `main` (commit `e765aa0`, version 1.49.0), avant la refonte.
Les chemins cités sont relatifs à `whatsapp-ai-saas/`. Les constats marqués **reproduit** ont été vérifiés par exécution ; les autres viennent de la lecture du code.

## Sommaire

- [Synthèse](#synthèse)
- [À corriger sur la 1.49 pendant la refonte](#à-corriger-sur-la-149-pendant-la-refonte)
- [Trois décisions avant d'écrire du code](#trois-décisions-avant-décrire-du-code)
- [Index des constats](#index-des-constats)
- [Constats détaillés](#constats-détaillés) : [Sécurité](#sécurité) · [Données](#données-et-persistance) · [Architecture](#architecture-et-backend) · [Interface](#interface-et-vues) · [Qualité](#qualité-et-outillage)
- [Ce qu'il faut garder](#ce-quil-faut-garder)
- [Cible technique](#cible-technique)
- [Ordre des travaux](#ordre-des-travaux)
- [Méthode](#méthode)
- [Annexe : mesures brutes](#annexe--mesures-brutes)

## Synthèse

Le code est soigné à l'échelle du fichier : les commentaires expliquent les choix, les correctifs sont testés, la CI refuse le moindre avertissement. L'architecture, elle, a empilé des couches qui se gênent : une application Electron qui pilote WhatsApp Web par son port de débogage, un serveur local capable d'exécuter n'importe quelle commande, deux bases de données qui se partagent les mêmes objets, une interface sans système de design.

La refonte est justifiée. Elle doit commencer par trois décisions de cadrage ; l'interface vient ensuite. Refaire l'interface sur la pile actuelle reproduirait les mêmes problèmes.

| Indicateur | Valeur |
|---|---|
| Code applicatif | ~34 000 lignes : backend 13 491, frontend 18 940, Electron et CLI 1 607 (plus 2 803 lignes de tests et 4 300 de traductions) |
| Surface | 83 routes REST, 27 écrans, 33 outils MCP, 26 personas, 5 fournisseurs LLM |
| Tests | 28 fichiers, 258 réussis, 3 ignorés, 0 échec (63 s) |
| Couverture | 13,8 % des instructions ; frontend 0 %, routes 7 % |
| ESLint | 0 erreur, 0 avertissement |
| Build Vite | réussi en 15,6 s |
| Alertes npm | 39 : backend 15 (1 critique, 7 hautes), racine 24 (2 critiques dans l'outillage de dev, 5 dans les dépendances de production) |
| Electron | 41.10.7, plus maintenu (dernière majeure : 45) |

**Répartition des 40 constats :** 2 critiques, 11 élevés, 20 moyens, 7 faibles.

## À corriger sur la 1.49 pendant la refonte

La version actuelle reste installée chez les utilisateurs le temps de la refonte. Ces correctifs sont courts et ferment les risques les plus graves.

1. Supprimer `/api/cli/run-external` et le mode « external » de `/api/cli/test-bridge`. Retirer `node`, `python`, `npx`, `curl`, `git` et `gh` de la liste blanche, et refuser la clé `allowed_cli_commands` dans `PUT /api/settings`. *(S1)*
2. Ne plus router un message WhatsApp entrant vers le canal CLI, et ne transmettre aux binaires lancés qu'un environnement minimal construit à la main. *(S3, S4)*
3. Limiter les mises à jour au dépôt `auceps-dev-team/wacopilote-releases` et vérifier une empreinte SHA-256 publiée avec la release avant de lancer l'installeur. *(S5)*
4. Corriger l'enregistrement des agents (un paramètre par marqueur) et afficher l'erreur dans le gestionnaire d'agents quand la requête échoue. *(D1)*
5. Lancer `npm audit fix` à la racine et dans `backend/`, puis activer Dependabot sur les deux. *(S9)*
6. Passer à une version d'Electron encore maintenue. *(S6)*

## Trois décisions avant d'écrire du code

Elles fixent l'architecture cible. Les reporter revient à refaire la même pile avec une nouvelle interface.

### 1. Périmètre : quel est le produit ?

- **Cœur WhatsApp** : conversations et copilote, contacts et segments, commandes détectées, prospection.
- **Modules à trancher** : studio photo (4 écrans), rédacteur IA, tâches, devis, boîte à outils, chat multi-agents.

Le recentrage annoncé en 1.49 n'apparaît pas encore dans la navigation (F6).

### 2. Canal WhatsApp : API officielle ou automatisation du web ?

- **API WhatsApp Business Cloud** : webhooks, modèles de messages approuvés, facturation par conversation. Exige un serveur joignable depuis Internet.
- **Automatisation de WhatsApp Web** : gratuite et multi-comptes tout de suite. Casse à chaque mise à jour de WhatsApp et expose les comptes au bannissement.

C'est la décision qui conditionne toutes les autres (A1, S2).

### 3. Forme : bureau seul ou SaaS ?

- **Bureau seul** : logique métier dans le processus principal, IPC typé, plus de serveur HTTP local ni de port de débogage ouvert.
- **SaaS** : vrai serveur et PostgreSQL, comptes utilisateurs ; l'application de bureau devient un client.

L'API officielle pousse vers le SaaS ; l'automatisation du web impose le bureau.

## Index des constats

| ID | Sévérité | Constat |
|---|---|---|
| [S1](#s1--lapi-locale-exécute-nimporte-quelle-commande) | Critique | L'API locale exécute n'importe quelle commande |
| [S2](#s2--port-de-débogage-chromium-8315-ouvert-en-production) | Critique | Port de débogage Chromium 8315 ouvert en production |
| [S3](#s3--des-messages-clients-peuvent-atteindre-claude-code-ou-gemini-cli) | Élevée | Des messages clients peuvent atteindre Claude Code ou Gemini CLI |
| [S4](#s4--clé-maître-et-clés-api-transmises-aux-binaires-tiers) | Élevée | Clé maître et clés API transmises aux binaires tiers |
| [S5](#s5--mises-à-jour-sans-contrôle-dorigine-strict-ni-signature) | Élevée | Mises à jour sans contrôle d'origine strict ni signature |
| [S6](#s6--electron-41-nest-plus-maintenu) | Élevée | Electron 41 n'est plus maintenu |
| [S7](#s7--durcissement-electron-incomplet) | Moyenne | Durcissement Electron incomplet |
| [S8](#s8--connexion-google-fragile) | Moyenne | Connexion Google fragile |
| [S9](#s9--39-alertes-npm-et-aucune-veille-automatique) | Moyenne | 39 alertes npm et aucune veille automatique |
| [S10](#s10--surfaces-de-diagnostic-en-production) | Faible | Surfaces de diagnostic en production |
| [D1](#d1--modifier-un-agent-personnalisé-échoue-sans-le-dire) | Élevée | Modifier un agent personnalisé échoue sans le dire |
| [D2](#d2--les-clés-étrangères-ne-sont-pas-appliquées) | Élevée | Les clés étrangères ne sont pas appliquées |
| [D3](#d3--trois-processus-sur-un-même-fichier-sqlite) | Moyenne | Trois processus sur un même fichier SQLite |
| [D4](#d4--une-fausse-couche-postgresql) | Moyenne | Une fausse couche PostgreSQL |
| [D5](#d5--schéma-et-migrations-entremêlés) | Moyenne | Schéma et migrations entremêlés |
| [D6](#d6--deux-sources-de-vérité) | Moyenne | Deux sources de vérité |
| [D7](#d7--numéros-de-devis-tirés-au-hasard) | Moyenne | Numéros de devis tirés au hasard |
| [D8](#d8--emplacement-des-données-ambigu) | Faible | Emplacement des données ambigu |
| [A1](#a1--whatsapp-piloté-par-automatisation-non-officielle) | Élevée | WhatsApp piloté par automatisation non officielle |
| [A2](#a2--quatre-processus-trois-protocoles-des-ports-fixes) | Élevée | Quatre processus, trois protocoles, des ports fixes |
| [A3](#a3--couche-llm-sans-interface-commune) | Moyenne | Couche LLM sans interface commune |
| [A4](#a4--garde-de-réentrance-partagée-entre-toutes-les-requêtes) | Moyenne | Garde de réentrance partagée entre toutes les requêtes |
| [A5](#a5--destination-des-données-clients-non-maîtrisée) | Moyenne | Destination des données clients non maîtrisée |
| [A6](#a6--prompts-passés-en-ligne-de-commande) | Moyenne | Prompts passés en ligne de commande |
| [A7](#a7--le-cli-nest-pas-livré-avec-lapplication) | Moyenne | Le CLI n'est pas livré avec l'application |
| [A8](#a8--quota-dimages-contournable) | Moyenne | Quota d'images contournable |
| [A9](#a9--validation-des-entrées-inégale) | Faible | Validation des entrées inégale |
| [A10](#a10--personas-en-double-et-mal-affectés) | Faible | Personas en double et mal affectés |
| [F1](#f1--pas-de-système-de-design) | Élevée | Pas de système de design |
| [F2](#f2--accessibilité-presque-absente) | Élevée | Accessibilité presque absente |
| [F3](#f3--composants-monolithiques) | Moyenne | Composants monolithiques |
| [F4](#f4--couche-réseau-implicite) | Moyenne | Couche réseau implicite |
| [F5](#f5--traduction-incomplète-arabe-mal-mis-en-page) | Moyenne | Traduction incomplète, arabe mal mis en page |
| [F6](#f6--navigation-encore-généraliste) | Moyenne | Navigation encore généraliste |
| [F7](#f7--code-mort) | Faible | Code mort |
| [F8](#f8--polices-chargées-depuis-google-à-chaque-démarrage) | Faible | Polices chargées depuis Google à chaque démarrage |
| [Q1](#q1--couverture-de-138--frontend-à-0-) | Élevée | Couverture de 13,8 %, frontend à 0 % |
| [Q2](#q2--aucun-typage) | Moyenne | Aucun typage |
| [Q3](#q3--versionnement-manuel-coûteux) | Moyenne | Versionnement manuel coûteux |
| [Q4](#q4--des-commentaires-qui-racontent-lhistorique) | Faible | Des commentaires qui racontent l'historique |

## Constats détaillés

### Sécurité

#### S1 — L'API locale exécute n'importe quelle commande

**Critique.** `POST /api/cli/run-external` et le mode « external » de `/api/cli/test-bridge` lancent un binaire avec des arguments choisis par l'appelant. La liste blanche contient `node`, `python`, `npx`, `curl`, `git` et `gh` : `node -e` suffit pour exécuter du code arbitraire. `POST /api/cli/settings` et `PUT /api/settings` permettent en plus d'ajouter n'importe quel binaire à la liste. Toute fuite du jeton API (XSS dans le renderer, accès par le port de débogage, voir S2) donne donc l'exécution de code sur le poste.

Références : [backend/services/externalAgentRunner.js:16](../backend/services/externalAgentRunner.js#L16) · [backend/routes/cliBridge.js:69](../backend/routes/cliBridge.js#L69), [:99](../backend/routes/cliBridge.js#L99), [:227](../backend/routes/cliBridge.js#L227) · [backend/routes/settings_and_agents.js:41](../backend/routes/settings_and_agents.js#L41)

#### S2 — Port de débogage Chromium 8315 ouvert en production

**Critique.** `remote-debugging-port=8315` est activé sans condition. Tout processus local peut s'y connecter, lire les sessions WhatsApp des webviews, exécuter du JavaScript dans le renderer et y récupérer le jeton API. Le backend dépend de ce port pour toute l'automatisation WhatsApp : le fermer demande de revoir l'architecture.

Références : [electron/main.cjs:85](../electron/main.cjs#L85) · [backend/server.js:153](../backend/server.js#L153) · [backend/orderListener.js](../backend/orderListener.js) · [backend/routes/wa.js](../backend/routes/wa.js)

#### S3 — Des messages clients peuvent atteindre Claude Code ou Gemini CLI

**Élevée.** Le détecteur de commandes insère le texte et le nom du contact WhatsApp dans un prompt par simple concaténation. Si la cascade de repli bascule sur le canal CLI, ce texte devient l'argument de `claude -p` ou de `gemini -p` (avec `GEMINI_CLI_TRUST_WORKSPACE=true`), deux outils capables de lire le disque. Un client peut ainsi glisser des instructions à un agent qui a accès aux fichiers du poste.

Références : [backend/orderListener.js:25](../backend/orderListener.js#L25) · [backend/services/agentFallbackRouter.js:194-223](../backend/services/agentFallbackRouter.js#L194-L223)

#### S4 — Clé maître et clés API transmises aux binaires tiers

**Élevée.** En production, Electron passe la clé maître au backend dans la variable `WACOPILOTE_MASTER_KEY`. `executeExternalCli` donne ensuite tout `process.env` à chaque binaire lancé : claude, gemini, python ou curl reçoivent la clé qui déchiffre tous les secrets, plus `GEMINI_API_KEY`.

Références : [electron/main.cjs:193](../electron/main.cjs#L193) · [backend/services/externalAgentRunner.js:398](../backend/services/externalAgentRunner.js#L398)

#### S5 — Mises à jour sans contrôle d'origine strict ni signature

**Élevée.** L'URL de téléchargement vient du renderer, et tout chemin sur `github.com` ou `*.githubusercontent.com` est accepté, quel que soit le dépôt. L'installeur est ensuite lancé en silencieux (`/S`) sans vérification d'empreinte ni de signature. Les binaires publiés ne sont pas signés. `electron-updater`, qui gère ces contrôles, est installé mais pas utilisé.

Références : [electron/updater.cjs:93-96](../electron/updater.cjs#L93-L96), [:185](../electron/updater.cjs#L185)

#### S6 — Electron 41 n'est plus maintenu

**Élevée.** Electron ne corrige que ses trois dernières versions majeures et la plus récente est la 45. `npm audit` signale déjà une vulnérabilité haute sur le paquet (contrôles de permission HID et USB attribués à la mauvaise origine). Le Chromium embarqué ne recevra plus de correctifs, alors qu'il affiche du contenu tiers (WhatsApp Web). Electron est déclaré en `devDependencies`, si bien que `npm audit --omit=dev` ne le compte pas, alors qu'il est livré avec l'application.

Référence : [package.json](../package.json) (`electron ^41.10.7`)

#### S7 — Durcissement Electron incomplet

**Moyenne.**
- Pas de Content-Security-Policy, pas de `setWindowOpenHandler` ni de garde `will-navigate`.
- Webviews en `allowpopups`, et un `will-attach-webview` qui ne contrôle ni la source ni le preload.
- Pas de verrou d'instance unique : une seconde instance se heurte au port 3000.
- L'IPC `store-set` écrit n'importe quelle clé dans l'environnement du backend (`process.env[msg.key] = msg.value`), y compris `PATH` ou `NODE_OPTIONS`, hérités ensuite par les CLI lancés.

Références : [electron/main.cjs:117](../electron/main.cjs#L117), [:253](../electron/main.cjs#L253) · [backend/server.js:23-28](../backend/server.js#L23-L28) · [src/components/WorkArea.jsx:441](../src/components/WorkArea.jsx#L441)

#### S8 — Connexion Google fragile

**Moyenne.** Le flux OAuth de bureau utilise un `client_secret`, une `redirect_uri` fixée à `localhost:3000` et pas de PKCE. Le paramètre `state` sert d'identifiant de session sans être vérifié côté serveur. Côté interface, l'identifiant client retombe sur `"YOUR_GOOGLE_CLIENT_ID_HERE"`. Le profil Google ne sert qu'à l'affichage : il n'existe pas de compte utilisateur.

Références : [backend/routes/authGoogle.js:43-45](../backend/routes/authGoogle.js#L43-L45) · [src/App.jsx:176](../src/App.jsx#L176) · [src/pages/Profile.jsx:91](../src/pages/Profile.jsx#L91)

#### S9 — 39 alertes npm et aucune veille automatique

**Moyenne. Reproduit.** Backend : 15 alertes, dont 1 critique (`proxy-addr`) et 7 hautes (`body-parser`, `puppeteer-core`, `zod`, `undici`…). Racine : 24, dont 2 critiques dans l'outillage de développement (`concurrently` via `shell-quote`) et 5 dans les dépendances de production (`axios` en haute, `i18next`, `dompurify`). Le memory-bank indiquait 0 au 14 septembre : sans Dependabot ni Renovate, la dette revient en quelques semaines. Presque tout se corrige par `npm audit fix`. Le détail figure en [annexe](#alertes-npm).

#### S10 — Surfaces de diagnostic en production

**Faible.** `/api/debug/nvidia-model` vide le cache `require` à chaque appel. La plupart des routes renvoient `err.message` tel quel au client, et `express.json` accepte 50 Mo sur toutes les routes.

Références : [backend/routes/ai.js:47](../backend/routes/ai.js#L47) · [backend/server.js:53](../backend/server.js#L53)

### Données et persistance

#### D1 — Modifier un agent personnalisé échoue sans le dire

**Élevée. Reproduit.** `POST /api/agents` réutilise `$2…$6` dans sa clause `ON CONFLICT … DO UPDATE`. La couche de compatibilité remplace chaque `$n` par un `?` positionnel : 11 marqueurs pour 6 valeurs, les 5 derniers valent NULL. Résultat sur base en mémoire :

```
INSERT initial : OK
UPSERT (mise à jour) : ÉCHEC -> SQLITE_CONSTRAINT: NOT NULL constraint failed: ai_agents.name
```

L'écran ne teste pas `res.ok`, donc l'utilisateur croit avoir enregistré.

Références : [backend/routes/settings_and_agents.js:122](../backend/routes/settings_and_agents.js#L122) · [src/pages/AgentManager.jsx:42](../src/pages/AgentManager.jsx#L42)

#### D2 — Les clés étrangères ne sont pas appliquées

**Élevée. Reproduit.** `PRAGMA foreign_keys` vaut 0. Les `ON DELETE CASCADE` et `SET NULL` déclarés n'ont aucun effet : supprimer un segment ou une liste laisse des contacts pointer vers un identifiant disparu, supprimer un contact ou une campagne laisse des cartes pipeline orphelines. Activer le pragma demandera d'abord de nettoyer les orphelins existants.

Références : [backend/db.js:39-49](../backend/db.js#L39-L49) · [backend/routes/wa.js:105](../backend/routes/wa.js#L105), [:145](../backend/routes/wa.js#L145)

#### D3 — Trois processus sur un même fichier SQLite

**Moyenne.** Le serveur Express, le CLI et le serveur MCP ouvrent la même base en journal par défaut, sans WAL ni `busy_timeout`. Une écriture concurrente lève `SQLITE_BUSY` au lieu d'attendre son tour.

Référence : [backend/db.js:39-49](../backend/db.js#L39-L49)

#### D4 — Une fausse couche PostgreSQL

**Moyenne.** `pool` imite le client `pg` par expressions régulières (`$n` → `?`, `SERIAL`, `JSONB`) et devine si une requête renvoie des lignes d'après son premier mot : une requête `WITH …` ne renvoie rien. `pg` et `redis` restent en dépendances. Redis sert à un cache de 60 s dans une application de bureau et écrit un avertissement à chaque appel quand il est absent, c'est-à-dire presque toujours.

Références : [backend/db.js:52-82](../backend/db.js#L52-L82) · [backend/redisClient.js](../backend/redisClient.js)

#### D5 — Schéma et migrations entremêlés

**Moyenne.** Une fonction de 300 lignes mélange `CREATE TABLE IF NOT EXISTS` et migrations numérotées, avec une version 6 sautée volontairement. `db.run` n'exécute que la première instruction d'une chaîne : l'index unique déclaré dans le bloc `wa_contacts` n'existe que grâce à la migration 8.

Références : [backend/db.js:84-382](../backend/db.js#L84-L382) · [backend/db.js:188](../backend/db.js#L188)

#### D6 — Deux sources de vérité

**Moyenne.** Conversations IA, tâches, profil, instances, commandes détectées et leads vivent dans IndexedDB (Zustand persisté) ; contacts, devis et documents dans SQLite. La table `wa_instances` est un miroir écrit sans contrôle d'erreur (`fetch(...).catch(() => {})`). Le CLI et le MCP ne voient qu'une partie des données, et une réinstallation perd l'autre partie.

Références : [src/store.js](../src/store.js) · [src/App.jsx:141-163](../src/App.jsx#L141-L163)

#### D7 — Numéros de devis tirés au hasard

**Moyenne.** Format `INV-AAAA-XXX` avec XXX aléatoire : 900 valeurs par an, collisions probables, aucune séquence. Une numérotation chronologique et continue est en général exigée pour les factures.

Référence : [src/components/invoice/helpers.js:34](../src/components/invoice/helpers.js#L34)

#### D8 — Emplacement des données ambigu

**Faible.** `secretStore` bascule vers `%APPDATA%/WaCopilote` dès qu'une base y existe, alors que le jeton API de développement reste à la racine du projet : un backend lancé en développement peut ouvrir la base de production. Si le déchiffrement de `master-key.enc` échoue, le CLI génère une nouvelle clé en clair dans ce même dossier.

Références : [backend/secretStore.js:36-56](../backend/secretStore.js#L36-L56), [:147](../backend/secretStore.js#L147) · [backend/apiAuth.js:8-11](../backend/apiAuth.js#L8-L11)

### Architecture et backend

#### A1 — WhatsApp piloté par automatisation non officielle

**Élevée.** Lecture du DOM de WhatsApp Web (MutationObserver et sondage), clics simulés pour le catalogue, navigation vers `send?phone=` pour vérifier les numéros un par un. Chaque mise à jour de WhatsApp Web peut casser les sélecteurs (`div.message-in`, textes de modales en français et en anglais), et les conditions d'utilisation de WhatsApp interdisent les clients automatisés : les comptes des clients risquent le bannissement. Quand l'instance demandée est introuvable, la vérification de numéro utilise en silence le premier compte ouvert.

Références : [backend/orderListener.js:116-390](../backend/orderListener.js#L116-L390) · [backend/routes/wa.js:413-581](../backend/routes/wa.js#L413-L581), [:475](../backend/routes/wa.js#L475) · [backend/routes/catalog.js](../backend/routes/catalog.js)

#### A2 — Quatre processus, trois protocoles, des ports fixes

**Élevée.** Processus principal et renderer parlent en IPC, le renderer appelle Express en HTTP avec jeton, Express pilote Electron par CDP via puppeteer, et le CLI et le MCP écrivent dans la même base. Les ports 3000, 8315 et 5173 sont codés en dur. Pour une application mono-utilisateur, ce découpage multiplie les surfaces d'attaque (S1, S2) et les pannes au démarrage.

```
renderer React ──IPC──► processus principal Electron ──fork──► backend Express :3000
      │                         ▲                                   │
      └──HTTP + jeton───────────┼───────────────────────────────────┘
                                └──────── CDP :8315 (puppeteer) ◄───┘
CLI / serveur MCP ──in-process──► services backend ──► database.sqlite (partagée)
```

Références : [electron/main.cjs](../electron/main.cjs) · [backend/server.js](../backend/server.js) · [bin/wacopilote.cjs](../bin/wacopilote.cjs)

#### A3 — Couche LLM sans interface commune

**Moyenne.** Cinq services aux signatures différentes (`chatWithAgent(personaId, …)` d'un côté, `(persona, …, apiKey, baseURL, dbAgent)` de l'autre), le branchement par fournisseur répété trois fois, un fournisseur nommé `openai` qui désigne en réalité NVIDIA NIM et Together, et un catalogue `nvidiaModels` rechargé à chaque appel en vidant le cache `require`.

Références : [backend/aiController.js:41-107](../backend/aiController.js#L41-L107) · [backend/services/agentFallbackRouter.js:124-318](../backend/services/agentFallbackRouter.js#L124-L318)

#### A4 — Garde de réentrance partagée entre toutes les requêtes

**Moyenne.** `fallbackInFlight` est un booléen de module. Pendant qu'une requête parcourt la cascade, toute requête simultanée (un chat pendant une détection de commande, par exemple) la contourne et part directement sur le fournisseur par défaut, sans repli. Un contexte par requête (`AsyncLocalStorage` ou un paramètre explicite) règle le problème.

Référence : [backend/services/agentFallbackRouter.js:332](../backend/services/agentFallbackRouter.js#L332)

#### A5 — Destination des données clients non maîtrisée

**Moyenne.** La cascade automatique peut envoyer une même conversation à Google, puis à Anthropic via le CLI, puis à OpenRouter. Aucun écran n'indique quel fournisseur a traité quelle donnée, et l'utilisateur ne donne pas son accord fournisseur par fournisseur.

Référence : [backend/services/agentFallbackRouter.js:416-453](../backend/services/agentFallbackRouter.js#L416-L453)

#### A6 — Prompts passés en ligne de commande

**Moyenne.** Prompt système et message partent en un seul argument `-p`. Sous Windows, les lanceurs `.cmd` installés par npm passent par cmd.exe, limité à 8 191 caractères, et le contenu apparaît dans la liste des processus. Le modèle `ollama run llama3` est codé en dur.

Référence : [backend/services/agentFallbackRouter.js:194-198](../backend/services/agentFallbackRouter.js#L194-L198)

#### A7 — Le CLI n'est pas livré avec l'application

**Moyenne.** `build.files` n'inclut pas `bin/`. En version installée, la configuration MCP « en un clic » et le mode CLI de la console de test pointent vers `app.asar/bin/wacopilote.cjs`, qui n'existe pas, et supposent Node installé sur le poste. À l'inverse, `backend/**/*` embarquerait un `backend/.env` présent sur la machine de build (à confirmer sur un paquet réel).

Références : [package.json:86](../package.json#L86) · [backend/routes/cliBridge.js:22](../backend/routes/cliBridge.js#L22), [:44](../backend/routes/cliBridge.js#L44)

#### A8 — Quota d'images contournable

**Moyenne.** La limite de 40 images par mois sur la clé Gemini par défaut est comptée dans `app_settings`, que `PUT /api/settings` permet de réécrire. Si une clé éditeur est distribuée avec l'application, elle est aussi lisible sur le poste.

Référence : [backend/geminiService.js:9-70](../backend/geminiService.js#L9-L70)

#### A9 — Validation des entrées inégale

**Faible.** Zod ne protège qu'une route, `/api/ai/agent`, et son gestionnaire lit `error.errors`, propriété absente de Zod 4 : le détail renvoyé est toujours vide. Les 82 autres routes lisent `req.body` sans schéma.

Référence : [backend/routes/ai.js:170](../backend/routes/ai.js#L170)

#### A10 — Personas en double et mal affectés

**Faible.** 26 personas en fichiers JavaScript avec des prompts en dur (dont la marque « Auceps »), et une seconde liste de 20 identifiants codée dans `src/aiChatAgents.js`. Le persona de prospection à froid (`copywriter`) rédige aussi les réponses aux commandes entrantes.

Références : [backend/agents/personas/](../backend/agents/personas/) · [src/aiChatAgents.js](../src/aiChatAgents.js) · [backend/orderListener.js:27](../backend/orderListener.js#L27)

### Interface et vues

#### F1 — Pas de système de design

**Élevée.** 456 couleurs hexadécimales en dur dans le JSX, 416 valeurs Tailwind arbitraires, 347 attributs `style`, et trois palettes concurrentes : `primary` vaut `#10B981` dans `tailwind.config.js`, `--primary-color` vaut `#0b9f84` dans `global.css`, le reste en littéraux. 214 icônes SVG sont dessinées à la main alors que `lucide-react` est installé (utilisé dans 14 fichiers).

Références : [tailwind.config.js](../tailwind.config.js) · [src/styles/global.css](../src/styles/global.css)

#### F2 — Accessibilité presque absente

**Élevée.** 7 attributs `aria-*` et 4 `role` pour 55 composants, 15 `div` ou `span` cliquables, 34 `alert()` et `confirm()` natifs. Toutes les barres de défilement sont masquées en `!important` : rien n'indique qu'une zone défile.

Référence : [src/styles/global.css:4-20](../src/styles/global.css#L4-L20)

#### F3 — Composants monolithiques

**Moyenne.** 11 fichiers dépassent 590 lignes (voir [annexe](#composants-les-plus-volumineux)), pour 262 `useState` au total. Appels réseau, état et rendu cohabitent dans chaque page.

#### F4 — Couche réseau implicite

**Moyenne.** Une centaine d'appels `fetch(API_BASE_URL + …)` répartis dans 30 fichiers. `window.fetch` et `EventSource` sont remplacés globalement pour injecter le jeton, et le client `apiFetch` prévu n'est utilisé nulle part. Aucun cache ni invalidation : chaque page recharge tout à son montage, et beaucoup d'erreurs sont avalées.

Références : [src/services/apiAuth.js:67-87](../src/services/apiAuth.js#L67-L87) · [src/services/api.js](../src/services/api.js)

#### F5 — Traduction incomplète, arabe mal mis en page

**Moyenne.** Une centaine de lignes de texte restent hors `t()` (Réglages, pont CLI, Prospection, Commandes). L'arabe bascule la page en `dir="rtl"`, mais le code utilise 147 classes physiques (`ml-`, `pr-`, `left-`) contre 2 logiques : marges et alignements ne s'inversent pas. Le journal des 41 versions est codé en dur dans `Support.jsx` (38 Ko).

Références : [src/pages/Settings.jsx:291-638](../src/pages/Settings.jsx#L291-L638) · [src/pages/Support.jsx](../src/pages/Support.jsx)

#### F6 — Navigation encore généraliste

**Moyenne.** 27 routes et 13 entrées de premier niveau qui mélangent le cœur WhatsApp (hub, contacts, commandes, prospection) et des modules périphériques (studio photo en 4 écrans, rédacteur, tâches, devis, boîte à outils). Le recentrage WhatsApp de la 1.49 ne se voit pas encore dans le menu, et 7 routes n'y figurent pas (profil, documents, gestion des agents, réglages, ajout, édition et import de contacts).

Références : [src/constants/menuItems.jsx](../src/constants/menuItems.jsx) · [src/App.jsx:301-327](../src/App.jsx#L301-L327)

#### F7 — Code mort

**Faible.** `hooks/useOrderListener.js` (remplacé par la version globale), `services/api.js`, IPC `create-instance` et `remove-instance` sans effet, dépendance `electron-updater` inutilisée, `<title>` vide dans `index.html`.

#### F8 — Polices chargées depuis Google à chaque démarrage

**Faible.** Inter vient de `fonts.googleapis.com` : police de repli hors ligne, et adresse IP envoyée à Google à chaque ouverture. `Plus Jakarta Sans` et `JetBrains Mono`, déclarées dans la configuration Tailwind, ne sont jamais chargées.

Références : [index.html:9-11](../index.html#L9-L11) · [tailwind.config.js](../tailwind.config.js)

### Qualité et outillage

#### Q1 — Couverture de 13,8 %, frontend à 0 %

**Élevée. Reproduit.** Routes 7 %, scrapers 12 %, services 61 %. Aucun composant, page, hook ni store n'est exécuté par les tests : le frontend en compte 3 fichiers, dont un exemple. Le scénario Playwright de bout en bout existe mais n'est pas branché en CI. Détail en [annexe](#couverture-par-dossier).

Références : [src/\_\_tests\_\_/](../src/__tests__/) · [e2e/ci-snippet.yml](../e2e/ci-snippet.yml)

#### Q2 — Aucun typage

**Moyenne.** 34 000 lignes de JavaScript sans TypeScript ni JSDoc vérifié. Les contrats entre renderer, API, IPC et MCP sont implicites ; D1 et A9 en découlent directement.

#### Q3 — Versionnement manuel coûteux

**Moyenne.** Le numéro de version est recopié dans 8 fichiers (deux `package.json`, deux README, `installer.iss`, `Support.jsx`, `CliAgentBridgeSettings.jsx`, gabarit de bug) en plus du memory-bank, et le journal des changements vit dans le code de l'interface.

Références : [bump_version.sh (racine du dépôt)](../../bump_version.sh) · [src/pages/Support.jsx](../src/pages/Support.jsx)

#### Q4 — Des commentaires qui racontent l'historique

**Faible.** Beaucoup de commentaires décrivent les correctifs passés (« constat N14 », « C7 », « v1.42.13 ») plutôt que le comportement actuel. Git conserve déjà cet historique ; dans une base refondue, ces commentaires deviendront faux.

## Ce qu'il faut garder

Ces choix sont bons et doivent survivre à la refonte, quelle que soit la cible retenue.

- Backend lié à `127.0.0.1`, jeton comparé à temps constant.
- Secrets chiffrés au repos en AES-256-GCM, clé maître scellée par le coffre du système (DPAPI, Trousseau).
- Contenu des messages clients masqué dans les journaux (`logRedact`).
- Aucun envoi automatique : les réponses sont pré-remplies et l'humain envoie.
- Extraction du JSON des réponses LLM robuste et testée (`llmJson`).
- Logique métier extraite en services partagés par l'API, le CLI et le MCP, couverts à 61 %.
- CI stricte : ESLint sans avertissement, tests et build à chaque push.
- Parité des clés de traduction testée sur les 4 langues.
- Commentaires qui expliquent pourquoi un choix a été fait.

## Cible technique

Ces recommandations valent quelles que soient les trois décisions de cadrage.

| Domaine | Cible |
|---|---|
| Langage et dépôt | TypeScript strict, monorepo en workspaces : application, cœur métier, CLI et MCP partageant le même cœur. |
| Données | Une seule base et un vrai outil de migrations (Drizzle ou Kysely sur better-sqlite3), `foreign_keys=ON`, WAL, `busy_timeout`. |
| LLM | Une interface unique par fournisseur (`generate({ system, messages, schema, images })`), une politique de repli explicite, visible et consentie. |
| Délégation CLI | Liste fermée, arguments construits par le code, environnement minimal, jamais de contenu entrant non fiable. |
| Interface | Jetons de design dans un seul thème, composants accessibles (Radix ou React Aria), icônes lucide, TanStack Query pour les données, propriétés logiques pour le RTL, polices embarquées. |
| Distribution | Electron maintenu, electron-updater avec signature de code, verrou d'instance unique, CSP. |
| Qualité | Parcours clés en E2E Playwright dans la CI, Dependabot, seuil de couverture sur le cœur métier. |

## Ordre des travaux

Les phases 2 et 4 changent de contenu selon le canal WhatsApp et la forme retenus.

0. **Sécuriser la 1.49** : les six correctifs du début de ce document, livrés sur la branche actuelle.
1. **Trancher le cadrage** : périmètre, canal WhatsApp, bureau ou SaaS. Une page d'architecture courte qui fixe ces choix.
2. **Poser le socle** : TypeScript, workspaces, schéma de données et migrations, couche LLM, contrat typé entre interface et cœur (IPC ou API).
3. **Système de design et coquille** : jetons, composants accessibles, navigation regroupée par domaine, RTL réel, états vides et erreurs pensés dès le départ.
4. **Migrer les modules par valeur** : hub et conversations, puis contacts et segments, commandes, prospection, et enfin les modules conservés. Chaque module arrive avec ses tests.
5. **Qualité et distribution** : E2E en CI, signature de code, mises à jour vérifiées, veille des dépendances.

## Méthode

### Exécuté

- Lecture du backend (serveur, base, secrets, routes, services, routeur de repli, automatisation WhatsApp, MCP et CLI), d'Electron (main, preload, updater) et du frontend (App, store, navigation, pages principales).
- `npm ci` à la racine et dans `backend/`, sans téléchargement des binaires Electron, Playwright et Puppeteer.
- `vitest run` : 28 fichiers, 258 réussis, 3 ignorés, 63 s.
- `vitest run --coverage`, `eslint . --max-warnings=0` (0), `vite build` (réussi, 15,6 s).
- `npm audit` et `npm outdated` sur les deux espaces.
- Reproduction de D1 et D2 avec un script qui charge `backend/db.js` sur une base SQLite en mémoire, avec un `USER_DATA_PATH` temporaire hors du dépôt.

### Non exécuté

- Lancement de l'application Electron (binaires non téléchargés) et du scénario E2E.
- Construction d'un paquet d'installation : le contenu de `app.asar` n'a pas été inspecté, A7 reste à confirmer.
- Essais réels des scrapers et de WhatsApp Web.
- Les mesures de l'interface (couleurs, classes, attributs) viennent de recherches textuelles dans `src/` : ce sont des ordres de grandeur, pas un inventaire exact.

## Annexe : mesures brutes

### Couverture par dossier

`vitest run --coverage`, provider v8.

| Dossier | Instructions | Lignes |
|---|---:|---:|
| **Total** | **13,80 %** | **14,47 %** |
| backend | 22,59 % | 22,51 % |
| backend/agents | 78,57 % | 78,57 % |
| backend/mcp | 23,50 % | 22,83 % |
| backend/routes | 7,03 % | 7,27 % |
| backend/scrapers | 12,39 % | 12,25 % |
| backend/scripts | 0 % | 0 % |
| backend/services | 60,53 % | 61,59 % |
| src | 4,31 % | 4,21 % |
| src/components, src/components/ui, src/constants, src/hooks, src/lib, src/pages, src/services | 0 % | 0 % |
| src/utils | 24,07 % | 23,80 % |

### Alertes npm

État au 26 novembre 2026. « Correctif » indique si `npm audit fix` suffit ou si une montée de version majeure est nécessaire.

**Backend (15)**

| Paquet | Sévérité | Direct | Correctif | Motif principal |
|---|---|---|---|---|
| proxy-addr | critique | non | audit fix | usurpation d'IP via IPv6 mappé IPv4 |
| body-parser | haute | non | audit fix | déni de service (octets après un corps compressé) |
| brace-expansion | haute | non | audit fix | déni de service CPU |
| chromium-bidi | haute | non | audit fix | via puppeteer-core |
| puppeteer-core | haute | oui | audit fix | dépendances vulnérables |
| source-map-js | haute | non | audit fix | déni de service |
| undici | haute | non | audit fix | déni de service WebSocket |
| zod | haute | oui | audit fix | épuisement mémoire sur collections volumineuses |
| gaxios, glob, google-auth-library, ip-address, minimatch, qs, rimraf | moyenne | non | audit fix | divers |

**Racine (24)**

| Paquet | Sévérité | Direct | Correctif | Motif principal |
|---|---|---|---|---|
| shell-quote | critique | non | audit fix | injection de commande dans `quote()` |
| concurrently | critique | oui (dev) | audit fix | via shell-quote |
| axios | haute | oui | audit fix | pollution de prototype dans l'adaptateur fetch |
| electron | haute | oui (dev, livré) | majeure | permissions HID et USB attribuées à la mauvaise origine |
| follow-redirects | haute | non | audit fix | en-têtes d'authentification non retirés entre origines |
| vite | haute | oui (dev) | audit fix | échappement incomplet de launch-editor sous Windows |
| brace-expansion, joi, source-map-js, undici, zod | haute | non | audit fix | déni de service |
| i18next | moyenne | oui | audit fix | déni de service (deepExtend) |
| @vitest/mocker, vitest, @vitest/coverage-v8 | moyenne | oui (dev) | audit fix | injection via mock non authentifié |
| electron-builder, app-builder-lib, dmg-builder, @electron/universal | moyenne | oui (dev) | majeure | dépendances vulnérables |
| electron-builder-squirrel-windows, fast-uri, minimatch, postcss-selector-parser | moyenne | non | audit fix ou majeure | divers |
| dompurify | faible | oui | audit fix | gestionnaires d'événements conservés avec `IN_PLACE` |

### Versions majeures en retard

| Paquet | Installé | Dernière |
|---|---|---|
| electron | 41.10.7 | 45.5.0 |
| eslint / @eslint/js | 9.39 | 10 |
| @vitejs/plugin-react | 5.1.4 | 6.3.0 |
| vitest / @vitest/coverage-v8 | 4.1 | 5.1 |
| i18next | 26.0.3 | 27.2.9 |
| lucide-react | 0.577.0 | 1.81.0 |
| electron-store | 11.0.2 | 12.0.0 |
| concurrently | 9.2.4 | 10.0.7 |
| @testing-library/jest-dom | 6.9.1 | 8.0.0 |

### Composants les plus volumineux

| Fichier | Lignes |
|---|---:|
| src/components/image-editor/ImageEditor.jsx | 850 |
| src/pages/whatsapp/Prospection.jsx | 798 |
| src/pages/Settings.jsx | 796 |
| src/pages/AiChat.jsx | 784 |
| src/pages/PhotoShoot.jsx | 759 |
| src/pages/whatsapp/Contacts.jsx | 753 |
| src/pages/InvoiceBuilder.jsx | 753 |
| src/components/WorkArea.jsx | 689 |
| src/pages/TasksMap.jsx | 651 |
| src/pages/AdvancedAnalytics.jsx | 620 |
| src/pages/AiWriter.jsx | 598 |
| src/pages/AgentsHub.jsx | 488 |
| src/components/Sidebar.jsx | 482 |
| src/components/CliAgentBridgeSettings.jsx | 454 |
| src/pages/AgentPipeline.jsx | 447 |

### Indicateurs d'interface

Comptages par recherche textuelle dans `src/` (55 fichiers `.jsx`).

| Indicateur | Valeur |
|---|---:|
| Icônes `<svg>` écrites à la main | 214 |
| Fichiers qui importent `lucide-react` | 14 |
| Couleurs hexadécimales dans le JSX | 456 |
| Valeurs Tailwind arbitraires `-[…]` | 416 |
| Attributs `style={{…}}` | 347 |
| Classes `dark:` | 1 527 |
| Attributs `aria-*` | 7 |
| Attributs `role` | 4 |
| `<img>` / attributs `alt` | 36 / 30 |
| `div` ou `span` avec `onClick` | 15 |
| `alert()` et `confirm()` natifs | 34 |
| `useState` / `useEffect` | 262 / 42 |
| Fichiers `.jsx` qui utilisent `useTranslation` | 38 sur 55 |
| Lignes de texte affiché hors `t()` (estimation) | ~100 |
| Classes physiques (`ml-`, `pr-`, `left-`…) / logiques (`ms-`, `pe-`, `start-`…) | 147 / 2 |
| `!important` dans `global.css` | 26 |
| `console.log` restants | 11 |

### Bundle de production

`vite build`, principaux fichiers.

| Fichier | Taille | gzip |
|---|---:|---:|
| ui (lucide-react, recharts) | 391,96 kB | 116,39 kB |
| index (application) | 321,33 kB | 99,52 kB |
| ImageWorkspace | 123,12 kB | 33,07 kB |
| CSS | 108,59 kB | 17,78 kB |
| ar / fr / es / en (traductions) | 87,0 / 77,6 / 76,5 / 71,9 kB | 29,0 / 28,1 / 27,9 / 26,6 kB |
| InvoiceBuilder | 65,56 kB | 14,70 kB |
| vendor (react, router, zustand) | 50,15 kB | 17,87 kB |
| Settings | 48,29 kB | 11,04 kB |
| i18n | 48,03 kB | 15,78 kB |
