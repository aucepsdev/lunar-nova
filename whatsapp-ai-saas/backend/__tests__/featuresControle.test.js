// @vitest-environment node
//
// Contrôle des routes et chargement à la demande (Marketplace, ticket #30,
// PR 2) : la résolution d'une requête vers sa fonctionnalité, l'intergiciel
// et les arrêts à la désactivation, en mémoire. Le même contrôle est éprouvé
// sur le vrai serveur dans featuresApplication.test.js.
//
// Convention du projet : require, jamais import, pour partager l'instance de db.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';

const db = require('../db');
const features = require('../features');
const { fonctionnalites } = require('../featuresCatalogue');
const {
    controleFonctionnalites, fonctionnaliteDeRequete, routeurParesseux, routeursCharges
} = require('../controleFonctionnalites');

const concret = (chemin) => chemin.replace(/:[a-z_]+/gi, 'test-1');
const routes = fonctionnalites.flatMap((f) => f.surfaces.api.map((entree) => {
    const [methode, chemin] = entree.split(' ');
    return { feature: f.id, methode, chemin };
}));

// Une seule base en mémoire pour tout le fichier : db.js n'accepte de
// changer de fichier qu'avant la première requête.
beforeAll(async () => {
    db.__setDbFileForTests(':memory:');
    expect(await db.initDB()).toBe(true);
}, 30000);

describe('controleFonctionnalites — résolution d\'une requête', () => {
    it('chaque route du catalogue se résout vers sa propre fonctionnalité', () => {
        const erreurs = routes
            .filter((r) => fonctionnaliteDeRequete(r.methode, concret(r.chemin)) !== r.feature)
            .map((r) => `${r.methode} ${r.chemin} → ${fonctionnaliteDeRequete(r.methode, concret(r.chemin))}, attendu ${r.feature}`);
        expect(erreurs).toEqual([]);
    });

    // Une requête qui correspondrait à deux routes de fonctionnalités
    // différentes serait ambiguë : Express prendrait la première enregistrée,
    // que le catalogue ne connaît pas. Aucune ne doit exister.
    it('aucune requête ne peut correspondre à deux fonctionnalités', () => {
        const segments = (c) => c.split('/').filter(Boolean);
        const croisees = [];
        for (let i = 0; i < routes.length; i++) {
            for (let j = i + 1; j < routes.length; j++) {
                const a = routes[i];
                const b = routes[j];
                if (a.feature === b.feature || a.methode !== b.methode) continue;
                const sa = segments(a.chemin);
                const sb = segments(b.chemin);
                const chevauche = sa.length === sb.length && sa.every((s, k) =>
                    s.startsWith(':') || sb[k].startsWith(':') || s.toLowerCase() === sb[k].toLowerCase());
                if (chevauche) croisees.push(`${a.feature} ${a.methode} ${a.chemin} / ${b.feature} ${b.chemin}`);
            }
        }
        expect(croisees).toEqual([]);
    });

    it('reproduit la correspondance d\'Express 5 : casse, barre finale, HEAD, segment de paramètre', () => {
        expect(fonctionnaliteDeRequete('GET', '/API/Documents')).toBe('redaction');
        expect(fonctionnaliteDeRequete('GET', '/api/documents/')).toBe('redaction');
        expect(fonctionnaliteDeRequete('HEAD', '/api/documents')).toBe('redaction');
        expect(fonctionnaliteDeRequete('DELETE', '/api/wa/contacts/42')).toBe('crm');
        // Un paramètre ne couvre qu'un segment : Express ne servirait pas ces chemins.
        expect(fonctionnaliteDeRequete('DELETE', '/api/wa/contacts/42/x')).toBeNull();
        expect(fonctionnaliteDeRequete('GET', '/api/documentsx')).toBeNull();
        // Méthode absente du catalogue pour ce chemin.
        expect(fonctionnaliteDeRequete('PATCH', '/api/documents')).toBeNull();
    });
});

describe('controleFonctionnalites — intergiciel et chargement à la demande', () => {
    let server;
    let base;
    const charger = vi.fn(() => {
        const r = express.Router();
        r.get('/', (req, res) => res.json({ servi: true }));
        return r;
    });

    beforeAll(async () => {
        const app = express();
        app.use(controleFonctionnalites);
        app.use('/api/documents', routeurParesseux('redaction', charger));
        app.get('/api/health', (req, res) => res.json({ ok: true }));
        await new Promise((resolve) => {
            server = http.createServer(app).listen(0, '127.0.0.1', () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    }, 30000);

    afterAll(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('fonctionnalité éteinte : 403 FEATURE_DISABLED, et le routeur n\'est pas chargé', async () => {
        await features.definir('redaction', false);
        const res = await fetch(`${base}/api/documents`);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
            error: 'La fonctionnalité « redaction » est désactivée.',
            code: 'FEATURE_DISABLED',
            feature: 'redaction'
        });
        expect(charger).not.toHaveBeenCalled();
        expect(routeursCharges().has('redaction')).toBe(false);
    });

    it('réactivée : la route répond, et le routeur est chargé une seule fois', async () => {
        await features.definir('redaction', true);
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`${base}/api/documents`);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ servi: true });
        }
        expect(charger).toHaveBeenCalledTimes(1);
        expect(routeursCharges().has('redaction')).toBe(true);
    });

    it('le noyau passe sans condition', async () => {
        expect((await fetch(`${base}/api/health`)).status).toBe(200);
    });

    it('un chemin hors catalogue passe au routage, qui répond 404', async () => {
        expect((await fetch(`${base}/api/n-existe-pas`)).status).toBe(404);
    });
});

describe('features.quandDesactivee — arrêt des tâches de fond', () => {
    it('l\'arrêt s\'exécute à la désactivation, ni à l\'activation ni sur un refus', async () => {
        const arreter = vi.fn();
        const retirer = features.quandDesactivee('analyses', arreter);
        try {
            await features.definir('analyses', true);
            expect(arreter).not.toHaveBeenCalled();

            await features.definir('analyses', false);
            expect(arreter).toHaveBeenCalledTimes(1);

            // Refus (409) : rien n'est écrit, rien ne s'arrête.
            const arreterCrm = vi.fn();
            const retirerCrm = features.quandDesactivee('crm', arreterCrm);
            await expect(features.definir('crm', false)).rejects.toMatchObject({ code: 'FEATURE_REQUIRED_BY' });
            expect(arreterCrm).not.toHaveBeenCalled();
            retirerCrm();
        } finally {
            retirer();
        }
    });

    it('un arrêt en échec n\'empêche ni l\'écriture ni les autres arrêts', async () => {
        await features.definir('analyses', true);
        const enEchec = vi.fn(() => { throw new Error('page fermée'); });
        const autre = vi.fn();
        const r1 = features.quandDesactivee('analyses', enEchec);
        const r2 = features.quandDesactivee('analyses', autre);
        const journal = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(features.definir('analyses', false)).resolves.toMatchObject({ enabled: false });
            expect(autre).toHaveBeenCalledTimes(1);
            expect(await features.estActive('analyses')).toBe(false);
            expect(journal.mock.calls.flat().join(' ')).toMatch(/Arrêt de « analyses » incomplet : page fermée/);
        } finally {
            journal.mockRestore();
            r1();
            r2();
        }
    });

    it('une fonctionnalité inconnue est refusée à l\'enregistrement', () => {
        expect(() => features.quandDesactivee('n-existe-pas', () => {})).toThrow(features.ErreurFonctionnalite);
    });
});
