// @vitest-environment node
//
// Catalogue des fonctionnalités (Marketplace, ticket #30, PR 1).
//
// 1. Intégrité : forme des entrées, ids uniques, dépendances existantes, sans
//    cycle, noyau non désactivable.
// 2. Inventaire : chaque surface citée existe dans le code, et tout ce que le
//    code expose (route d'API, outil MCP, commande CLI, route et entrée de
//    menu de l'interface) appartient à exactement une fonctionnalité. Le code
//    est lu comme du texte, sans charger le backend.
// 3. Livraison : le catalogue est embarqué dans l'application construite.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..', '..');
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), 'utf8');
const catalogue = JSON.parse(lire('features/catalogue.json'));
const { fonctionnalites, ID_VALIDE } = require('../featuresCatalogue');

const SURFACES = ['routes', 'menu', 'api', 'mcp', 'cli'];
const CATEGORIES = ['noyau', 'whatsapp', 'ventes', 'ia', 'outils', 'acces-externes'];
const RISQUES = ['automatisation-whatsapp', 'acces-externe', 'execution-locale'];

// ── Lecture du code ─────────────────────────────────────────────────────────

const toutes = (texte, motif) => [...texte.matchAll(motif)].map((m) => m.slice(1));

const routesDeRouteur = (rel, prefixe) => toutes(lire(rel), /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)
    .map(([methode, chemin]) => `${methode.toUpperCase()} ${chemin === '/' ? prefixe : prefixe + chemin}`);

// Routeurs chargés à la demande (PR 2) :
// app.use('/prefixe', [intergiciels,] routeurParesseux('fonctionnalite', () => require('./fichier')[.creerRouteur()]))
function montagesParesseux() {
    return toutes(lire('backend/server.js'),
        /app\.use\('([^']+)',\s*(?:\w+\s*,\s*)*routeurParesseux\('([\w-]+)',\s*\(\)\s*=>\s*require\('\.\/([\w/-]+)'\)(?:\.\w+\(\))?\)\)/g)
        .map(([prefixe, feature, fichier]) => ({ prefixe, feature, rel: `backend/${fichier}.js` }));
}

function routesApi() {
    const server = lire('backend/server.js');
    // Routeurs : const x = require('./routes/f') ou const { x } = require(...)
    const fichierDe = new Map([
        ...toutes(server, /const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w-]+)'\)/g),
        ...toutes(server, /const\s*\{\s*(\w+)\s*\}\s*=\s*require\('\.\/routes\/([\w-]+)'\)/g),
    ]);
    const routes = [];
    // Montages : app.use('/prefixe', [intergiciels,] routeur) ou routeur()
    for (const [prefixe, ident] of toutes(server, /app\.use\('([^']+)',\s*(?:\w+\s*,\s*)*(\w+)(?:\(\))?\s*\)/g)) {
        if (fichierDe.has(ident)) routes.push(...routesDeRouteur(`backend/routes/${fichierDe.get(ident)}.js`, prefixe));
    }
    for (const { prefixe, rel } of montagesParesseux()) routes.push(...routesDeRouteur(rel, prefixe));
    // Routes déclarées directement sur l'application
    for (const [methode, chemin] of toutes(server, /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
        routes.push(`${methode.toUpperCase()} ${chemin}`);
    }
    return routes;
}

function outilsMcp() {
    const dossier = path.join(RACINE, 'backend/mcp/tools');
    return fs.readdirSync(dossier).filter((f) => f.endsWith('.js'))
        .flatMap((f) => toutes(fs.readFileSync(path.join(dossier, f), 'utf8'), /\bname:\s*'([a-z_]+)'/g).map(([n]) => n));
}

const commandesCli = () => toutes(lire('bin/wacopilote.cjs'), /command === '([^']+)'/g).map(([c]) => c);

const routesInterface = () => toutes(lire('src/App.jsx'), /path="([^"]+)"/g).map(([p]) => p).filter((p) => p !== '*');

// Entrées du menu, hors conteneurs déroulants (qui n'ouvrent aucune page).
const entreesMenu = () => lire('src/constants/menuItems.jsx').split('\n')
    .filter((l) => !/isDropdown:\s*true/.test(l))
    .flatMap((l) => toutes(l, /\bid:\s*'([^']+)'/g).map(([id]) => id));

const DU_CODE = {
    api: routesApi,
    mcp: outilsMcp,
    cli: commandesCli,
    routes: routesInterface,
    menu: entreesMenu,
};

// ── 1. Intégrité ────────────────────────────────────────────────────────────

describe('catalogue — intégrité', () => {
    it('chaque entrée a la forme attendue', () => {
        expect(catalogue.version).toBe(1);
        for (const f of catalogue.fonctionnalites) {
            expect(f.id, JSON.stringify(f)).toMatch(ID_VALIDE);
            expect(typeof f.labelKey).toBe('string');
            expect(typeof f.descriptionKey).toBe('string');
            expect(CATEGORIES).toContain(f.categorie);
            expect(typeof f.defaut).toBe('boolean');
            expect(typeof f.noyau).toBe('boolean');
            expect(Array.isArray(f.dependances)).toBe(true);
            for (const r of f.risques) expect(RISQUES).toContain(r);
            expect(Object.keys(f.surfaces).sort()).toEqual([...SURFACES].sort());
            for (const s of SURFACES) {
                expect(Array.isArray(f.surfaces[s])).toBe(true);
                for (const v of f.surfaces[s]) expect(typeof v).toBe('string');
            }
        }
    });

    it('ids uniques, et le module expose le même catalogue', () => {
        const ids = catalogue.fonctionnalites.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(fonctionnalites.map((f) => f.id)).toEqual(ids);
    });

    it('chaque dépendance existe, n\'est pas la fonctionnalité elle-même, et le graphe est sans cycle', () => {
        const parId = new Map(catalogue.fonctionnalites.map((f) => [f.id, f]));
        for (const f of catalogue.fonctionnalites) {
            for (const d of f.dependances) {
                expect(parId.has(d), `${f.id} → ${d}`).toBe(true);
                expect(d).not.toBe(f.id);
            }
        }
        const etat = new Map(); // 1 : en cours, 2 : terminé
        const visiter = (id, chemin) => {
            if (etat.get(id) === 2) return;
            if (etat.get(id) === 1) throw new Error(`cycle : ${[...chemin, id].join(' → ')}`);
            etat.set(id, 1);
            for (const d of parId.get(id).dependances) visiter(d, [...chemin, id]);
            etat.set(id, 2);
        };
        for (const f of catalogue.fonctionnalites) expect(() => visiter(f.id, [])).not.toThrow();
    });

    it('le noyau existe, est actif par défaut et ne dépend de rien', () => {
        const noyau = catalogue.fonctionnalites.filter((f) => f.noyau);
        expect(noyau.map((f) => f.id)).toEqual(['noyau']);
        for (const f of noyau) {
            expect(f.defaut).toBe(true);
            expect(f.dependances).toEqual([]);
        }
    });

    it('aucun élément n\'appartient à deux fonctionnalités', () => {
        for (const s of SURFACES) {
            const vus = new Map();
            for (const f of catalogue.fonctionnalites) {
                for (const v of f.surfaces[s]) {
                    expect(vus.has(v), `${s} « ${v} » : ${vus.get(v)} et ${f.id}`).toBe(false);
                    vus.set(v, f.id);
                }
            }
        }
    });

    // Les risques déclenchent la confirmation à l'activation (PR 4) : écrits en
    // dur, pour qu'un risque retiré ou ajouté par erreur fasse échouer la CI
    // (ticket #30 §4). `crm` n'en porte aucun : le mainteneur juge la
    // vérification des numéros (POST /api/wa/verify-contact) sans danger
    // (décision du 28/11, relecture de #39).
    it('chaque risque est porté par la fonctionnalité prévue', () => {
        const risques = Object.fromEntries(catalogue.fonctionnalites
            .filter((f) => f.risques.length)
            .map((f) => [f.id, f.risques]));
        expect(risques).toEqual({
            commandes: ['automatisation-whatsapp'],
            'mcp-externe': ['acces-externe'],
            'agents-cli-locaux': ['execution-locale'],
        });
    });
});

// ── 2. Inventaire ───────────────────────────────────────────────────────────

describe('catalogue — inventaire confronté au code', () => {
    it('la lecture du code trouve bien les surfaces (garde contre une recherche qui ne voit rien)', () => {
        expect(routesApi()).toEqual(expect.arrayContaining([
            'GET /api/health', 'POST /api/prospection/search-stream', 'GET /api/wa/selectors',
            'GET /api/orders', 'PUT /api/features/:id', 'GET /api/documents',
        ]));
        expect(outilsMcp()).toEqual(expect.arrayContaining(['prospect_leads', 'call_agent', 'get_orders']));
        expect(commandesCli()).toEqual(expect.arrayContaining(['prospect', 'mcp', '--help']));
        expect(routesInterface()).toEqual(expect.arrayContaining(['/wa/prospection', '/dashboard']));
        expect(entreesMenu()).toEqual(expect.arrayContaining(['wa-prospection', 'dashboard']));
        expect(entreesMenu()).not.toContain('whatsapp');
    });

    for (const s of SURFACES) {
        it(`${s} : chaque élément du catalogue existe dans le code`, () => {
            const code = new Set(DU_CODE[s]());
            const fictifs = catalogue.fonctionnalites.flatMap((f) => f.surfaces[s].filter((v) => !code.has(v)).map((v) => `${f.id} : ${v}`));
            expect(fictifs).toEqual([]);
        });

        it(`${s} : tout ce que le code expose appartient à une fonctionnalité`, () => {
            const attribues = new Set(catalogue.fonctionnalites.flatMap((f) => f.surfaces[s]));
            const orphelins = [...new Set(DU_CODE[s]())].filter((v) => !attribues.has(v));
            expect(orphelins).toEqual([]);
        });
    }

    // Règle 5.2 de l'étude (PR 2) : un routeur chargé à la demande ne doit
    // servir que la fonctionnalité qu'il annonce. Sinon, une autre
    // fonctionnalité active le chargerait, et la règle ne tiendrait plus.
    it('chaque routeur chargé à la demande ne sert que la fonctionnalité qu\'il annonce', () => {
        const montages = montagesParesseux();
        expect(montages.map((m) => m.feature).sort())
            .toEqual(['commandes', 'devis-factures', 'pipeline', 'prospection', 'redaction']);
        const fonctionnaliteDe = new Map(catalogue.fonctionnalites.flatMap((f) => f.surfaces.api.map((a) => [a, f.id])));
        const ecarts = montages.flatMap(({ prefixe, feature, rel }) => routesDeRouteur(rel, prefixe)
            .filter((route) => fonctionnaliteDe.get(route) !== feature)
            .map((route) => `${rel} (${feature}) : ${route} → ${fonctionnaliteDe.get(route)}`));
        expect(ecarts).toEqual([]);
    });
});

// ── 3. Livraison ────────────────────────────────────────────────────────────

describe('catalogue — livraison', () => {
    it('package.json > build.files embarque features/catalogue.json', () => {
        const fichiers = require(path.join(RACINE, 'package.json')).build.files;
        const embarque = fichiers.includes('features/catalogue.json')
            || fichiers.some((m) => m.endsWith('/**/*') && 'features/catalogue.json'.startsWith(m.slice(0, -'**/*'.length)));
        expect(embarque).toBe(true);
    });
});
