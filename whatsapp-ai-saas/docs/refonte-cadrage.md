# Cadrage de la refonte WaCopilote

Décisions prises le 26 novembre 2026, à partir de l'[audit de la 1.49](audit.md). Ce document fixe le périmètre et l'architecture cible. Il sert de référence pour la phase 2 (socle) et suivantes ; une décision qui le contredit doit d'abord le modifier.

## Les trois décisions

| Décision | Choix | Conséquence principale |
|---|---|---|
| Périmètre | Cœur WhatsApp, prospection et pipeline, devis et factures, rédacteur et chat multi-agents | Le studio photo, les tâches et la boîte à outils sortent du produit |
| Canal WhatsApp | Automatisation de WhatsApp Web | L'application reste sur le poste de l'utilisateur ; le risque de bannissement et la fragilité des sélecteurs sont acceptés et doivent être gérés (voir plus bas) |
| Forme | Application de bureau, cœur métier découplé | Electron reste ; la logique métier ne dépend ni d'Electron ni de l'interface, pour qu'une version SaaS reste possible sans réécriture |

## Périmètre

### Conservé

| Domaine | Écrans actuels | Notes |
|---|---|---|
| Hub WhatsApp | `/whatsapp-hub` (webviews multi-comptes), copilote de réponse | Cœur du produit |
| Contacts | `/wa/contacts`, ajout, édition, import, `/wa/contact-lists`, `/wa/segments` | |
| Commandes | `/wa/orders`, détection d'intention (Order Radar) | |
| Prospection | `/wa/prospection`, `/agent-pipeline` | Scraping Google Maps et annuaires, Kanban, brouillons d'approche |
| Devis et factures | `/invoice-builder` | Numérotation à refaire (constat D7) |
| Rédacteur et agents | `/ai-writer`, `/my-documents`, `/ai-chat`, `/agents-manager` | Personas à réduire à ceux utiles à ces domaines |
| Transverse | `/dashboard`, `/analytics`, `/settings`, `/support`, `/profile` | Tableau de bord et analyses : à confirmer (voir questions ouvertes) |

### Retiré

| Module | Ce qui part |
|---|---|
| Studio photo IA | `/agents` (photo produit), `/fashion/photoshoot`, `/fashion/edit`, `/fashion/image-generation` ; `components/image-editor`, `components/photoshoot`, `constants/photoshootPresets.jsx` ; 11 Mo d'images dans `public/assets/{poses,backgrounds,models}` ; génération d'images côté backend (Gemini image, Together/Qwen, modèles image de `nvidiaModels.js`) ; personas `photoshoot` et, s'il ne sert qu'au studio, `creative` ; outil MCP `generate_photo` et commande CLI `photo` ; dépendances `react-dropzone` et `piexifjs` |
| Tâches | `/tasks` (`TasksMap.jsx`) |
| Boîte à outils | `/tools` (`ToolsBox.jsx`) |

Environ 3 800 lignes d'interface disparaissent avec ces modules. Le retrait peut se faire **dans la 1.x avant la refonte**, comme celui du pont WordPress en 1.49.0 : la refonte part alors d'un périmètre déjà réduit.

## Architecture cible

```
┌──────────────────────── Application Electron ─────────────────────────┐
│                                                                        │
│  Renderer (React)              Processus principal                     │
│  interface seule  ◄──IPC typé──► fenêtres, webviews,                   │
│        │                         adaptateur WhatsApp (CDP interne)     │
│        │                                │                              │
│        └──── MessagePort typé ────┐     │ événements WhatsApp          │
│                                   ▼     ▼                              │
│                      utilityProcess « cœur »                           │
│                      domaine, SQLite, LLM, scraping                    │
└────────────────────────────────────────────────────────────────────────┘
          ▲
          │ même package « core », appelé en process
   CLI / serveur MCP
```

### Ce qui change par rapport à la 1.49

| 1.49 | Cible | Constats résolus |
|---|---|---|
| Serveur Express local sur le port 3000, protégé par un jeton | **Plus de serveur HTTP.** Le renderer parle au cœur par un `MessagePort` et au processus principal par IPC, avec des contrats typés | S1, S7, A2, F4, D8 |
| Port de débogage Chromium 8315 ouvert, piloté par puppeteer depuis le backend | **Plus de port.** L'adaptateur WhatsApp utilise `webContents.debugger` sur chaque webview, depuis le processus principal | S2, A2 |
| Deux bases : SQLite et IndexedDB (Zustand persisté) | Une seule base SQLite dans le cœur ; le renderer ne garde que l'état d'affichage | D6 |
| Couche « pg » simulée, migrations mêlées au schéma | `better-sqlite3`, schéma et migrations gérés par Drizzle ou Kysely, `foreign_keys=ON`, WAL, `busy_timeout` | D2, D3, D4, D5 |
| Cinq services LLM aux signatures différentes | Une interface `generate({ system, messages, schema, images })` par fournisseur, une politique de repli explicite et visible | A3, A4, A5 |
| JavaScript | TypeScript strict, monorepo en workspaces | Q2 |
| Couleurs et composants ad hoc | Jetons de design, composants accessibles (Radix ou React Aria), icônes lucide, propriétés logiques pour le RTL, polices embarquées | F1, F2, F5, F8 |

### Paquets du monorepo

| Paquet | Contenu | Dépend de |
|---|---|---|
| `core` | Domaine (contacts, segments, commandes, pipeline, devis, documents, agents, réglages), accès aux données, interface LLM, scrapers. Aucune dépendance à Electron | — |
| `whatsapp-adapter` | Pilotage d'une webview WhatsApp par CDP : lecture des messages, ouverture de conversation, pré-remplissage. Sélecteurs regroupés et versionnés | — |
| `contracts` | Types et schémas (zod) des échanges renderer ↔ principal ↔ cœur | — |
| `desktop` | Electron : processus principal, preload, renderer React | `core`, `whatsapp-adapter`, `contracts` |
| `cli` | CLI et serveur MCP | `core`, `contracts` |

Le cœur ne connaît que des interfaces (dépôt de données, fournisseur LLM, horloge). Une version SaaS remplacerait SQLite par PostgreSQL et le `MessagePort` par une API HTTP, sans toucher au domaine.

## Automatisation de WhatsApp Web : conditions

Le choix de l'automatisation accepte deux risques documentés dans l'audit (A1) : la casse à chaque mise à jour de WhatsApp Web et le bannissement des comptes. Ces conditions les réduisent sans les supprimer.

1. **Pas de port réseau.** `webContents.debugger.attach()` sur la webview donne le même protocole CDP que le port 8315, sans l'ouvrir aux autres programmes du poste. Les liaisons `Runtime.addBinding` remplacent `exposeFunction` de puppeteer.
2. **Sélecteurs isolés.** Tous les sélecteurs et textes de WhatsApp Web vivent dans un seul module de `whatsapp-adapter`, avec un contrôle de santé au démarrage (« les éléments attendus sont-ils présents ? ») qui désactive proprement la fonction concernée et le signale, au lieu d'échouer en silence.
3. **Tests sur instantanés.** Des copies du DOM de WhatsApp Web, enregistrées et anonymisées, servent de jeu de test aux sélecteurs : une refonte de WhatsApp se détecte en CI.
4. **Comportement humain.** L'envoi reste manuel (message pré-rempli, l'utilisateur appuie sur « Envoyer »). La vérification de numéros est plafonnée et espacée. Aucune action en masse sans délai aléatoire.
5. **Compte ciblé explicitement.** Toute action désigne l'instance par son identifiant ; plus de repli silencieux sur le premier compte ouvert.
6. **Information de l'utilisateur.** L'écran de connexion d'un compte indique clairement le risque lié aux conditions de WhatsApp.
7. **Contenu tiers.** Les messages entrants ne sont jamais confiés à un agent local (règle `untrustedInput` de la 1.49.1, conservée dans le cœur).

## Migration des utilisateurs existants

- La 1.x reste publiée et maintenue (correctifs de sécurité uniquement) jusqu'à la parité fonctionnelle de la 2.0.
- Au premier lancement, la 2.0 importe :
  - la base SQLite 1.49 (schéma v9) : contacts, listes, segments, commandes détectées, pipeline, devis, documents, agents, réglages ;
  - l'état IndexedDB du renderer (conversations IA, profil, instances), lu une fois par le renderer puis transmis au cœur ;
  - la clé maître scellée (`master-key.enc`) pour reprendre les secrets sans ressaisie.
- Les sessions WhatsApp (`partition: persist:<id>`) sont conservées en réutilisant les mêmes partitions : les utilisateurs n'ont pas à rescanner le QR code.
- L'import est testé sur une copie de base réelle anonymisée avant toute publication.

## Ordre des travaux

1. **Préalables sur la 1.x**
   - Publier la 1.49.1.
   - Rétablir la CI : aucun workflow n'a jamais tourné sur ce dépôt.
   - Retirer le studio photo, les tâches et la boîte à outils.
2. **Socle**
   - Monorepo TypeScript, `contracts`, `core` avec schéma, migrations et import 1.49, interface LLM.
   - CI avec typage, lint, tests et E2E.
3. **Adaptateur WhatsApp**
   - CDP interne, sélecteurs isolés, contrôle de santé, tests sur instantanés.
4. **Système de design et coquille**
   - Jetons, composants accessibles, navigation par domaine, RTL réel, états vides et erreurs.
5. **Modules, par valeur**
   - Hub et copilote, contacts et segments, commandes, prospection et pipeline, devis, rédacteur et chat.
   - Chaque module arrive avec ses tests.
6. **Distribution**
   - Signature de code, electron-updater, verrou d'instance unique, CSP, `safeStorage` asynchrone (obligatoire avant Electron 46), puis publication de la 2.0 avec import.

## Questions ouvertes

| Question | Pourquoi elle compte |
|---|---|
| Tableau de bord et analyses avancées : garder, fusionner en un seul écran, ou retirer ? | Deux écrans pour des indicateurs proches ; non tranché par le périmètre |
| Catalogue WhatsApp Business (envoi de produits par automatisation) : garder ? | Il dépend aujourd'hui des images du studio photo, qui sort |
| Connexion Google (profil) : garder ? | Elle ne sert qu'à afficher un nom et une photo, et porte un `client_secret` dans l'application (S8) |
| Canal CLI (Claude Code, Gemini CLI) et serveur MCP : garder ? | Fonction différenciante mais coûteuse à sécuriser ; les CLI ne peuvent déjà plus traiter le contenu tiers |
| Quatre langues dont l'arabe : garder ? | L'arabe impose un RTL réel dans le système de design |
| Personas : lesquels garder, et retirer la marque « Auceps » des prompts ? | 26 personas aujourd'hui, dont beaucoup sans lien avec le périmètre retenu |
| Cadre légal de la prospection (données d'entreprises récupérées, messages d'approche) | Conformité au droit local de la protection des données des marchés visés |
