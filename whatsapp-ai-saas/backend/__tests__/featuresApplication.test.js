// @vitest-environment node
//
// Application de l'état des fonctionnalités à l'API (Marketplace, ticket #30,
// PR 2), éprouvée sur le vrai serveur : backend/server.js lancé dans un
// processus à part, comme serverAuthOrder.test.js.
//
// 1. Couverture : toutes les fonctionnalités hors noyau sont éteintes, puis
//    CHAQUE route d'API du catalogue est appelée. Chacune doit répondre
//    403 FEATURE_DISABLED en nommant sa fonctionnalité. Le catalogue étant
//    lui-même confronté au code (featuresCatalogue.test.js), aucune route du
//    serveur n'échappe au contrôle.
// 2. Variantes qu'Express accepte pour la même route : casse, barre oblique
//    finale, HEAD pour GET, chaîne de requête, jeton en query des flux SSE.
// 3. Règle 5.2 de l'étude : le routeur d'une fonctionnalité éteinte n'est
//    jamais chargé ; il l'est à la première requête une fois réactivée.
//
// Isolation : port éphémère et dossier de données créé par mkdtemp — jamais
// le port 3000 ni la base réelle. Aucun gestionnaire de route hors noyau ne
// s'exécute tant que sa fonctionnalité est éteinte : c'est ce qui permet
// d'appeler sans risque des routes qui pilotent WhatsApp Web ou un navigateur.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'features/catalogue.json'), 'utf8'));
const horsNoyau = catalogue.fonctionnalites.filter((f) => !f.noyau);

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// Même délai large que serverAuthOrder.test.js : le démarrage rivalise avec
// le reste de la suite.
const BOOT_DEADLINE_MS = 60000;

async function waitForServer(base, child, stderr, deadlineMs) {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
        if (child.exitCode !== null) {
            throw new Error(`Le serveur s'est arrêté (code ${child.exitCode}) avant de répondre :\n${stderr().slice(-1500)}`);
        }
        try {
            await fetch(`${base}/api/health`);
            return;
        } catch { /* pas encore à l'écoute */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Le serveur n'a pas répondu en ${deadlineMs} ms (dépassement de délai, pas un échec d'assertion).`);
}

// Ordre d'extinction : une fonctionnalité ne s'éteint qu'une fois ses
// dépendantes éteintes (sinon 409 FEATURE_REQUIRED_BY).
function ordreExtinction(liste) {
    const reste = new Set(liste.map((f) => f.id));
    const ordre = [];
    while (reste.size) {
        const libre = [...reste].find((id) => !liste.some((f) => reste.has(f.id) && f.dependances.includes(id)));
        if (!libre) throw new Error('cycle de dépendances');
        ordre.push(libre);
        reste.delete(libre);
    }
    return ordre;
}

const concret = (chemin) => chemin.replace(/:[a-z_]+/gi, 'test-1');

describe('fonctionnalités — application à l\'API du vrai serveur', () => {
    let child;
    let base;
    let dataDir;
    let token;
    let errOutput = '';

    const appel = (methode, chemin, { avecJeton = true, entetes = {} } = {}) => fetch(`${base}${chemin}`, {
        method: methode,
        headers: {
            ...(avecJeton ? { Authorization: `Bearer ${token}` } : {}),
            ...(['POST', 'PUT', 'PATCH', 'DELETE'].includes(methode) ? { 'Content-Type': 'application/json' } : {}),
            ...entetes,
        },
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(methode) ? '{}' : undefined,
    });
    const basculer = async (id, enabled) => {
        const res = await fetch(`${base}/api/features/${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        expect(res.status, `${id} → ${enabled} : ${await res.clone().text()}`).toBe(200);
    };

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacopilote-features-'));
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, ['backend/server.js'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(port), USER_DATA_PATH: dataDir, NODE_ENV: 'test' },
            stdio: ['ignore', 'ignore', 'pipe']
        });
        child.stderr.on('data', (d) => { errOutput += d; });
        await waitForServer(base, child, () => errOutput, BOOT_DEADLINE_MS);
        token = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();
        const actives = (await (await appel('GET', '/api/features')).json()).data.filter((f) => f.enabled && !f.noyau);
        for (const id of ordreExtinction(actives)) await basculer(id, false);
    }, BOOT_DEADLINE_MS + 30000);

    afterAll(() => {
        if (child && !child.killed) child.kill();
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* fichier encore verrouillé */ }
    });

    it('toutes les fonctionnalités hors noyau sont éteintes', async () => {
        const etat = (await (await appel('GET', '/api/features')).json()).data;
        expect(etat.filter((f) => !f.noyau && f.enabled).map((f) => f.id)).toEqual([]);
    });

    it('chaque route d\'API d\'une fonctionnalité éteinte répond 403 FEATURE_DISABLED, en la nommant', async () => {
        const rates = [];
        let n = 0;
        for (const f of horsNoyau) {
            for (const entree of f.surfaces.api) {
                const [methode, chemin] = entree.split(' ');
                const res = await appel(methode, concret(chemin));
                const corps = await res.json().catch(() => null);
                n++;
                if (res.status !== 403 || corps?.code !== 'FEATURE_DISABLED' || corps?.feature !== f.id) {
                    rates.push(`${entree} (${f.id}) → ${res.status} ${JSON.stringify(corps)}`);
                }
            }
        }
        expect(rates).toEqual([]);
        expect(n).toBeGreaterThan(50);
    });

    it('les variantes d\'écriture acceptées par Express sont refusées de même', async () => {
        const cas = [
            ['GET', '/API/DOCUMENTS', 'redaction'],
            ['GET', '/api/documents/', 'redaction'],
            ['GET', '/api/documents?limit=1', 'redaction'],
            ['HEAD', '/api/invoices', 'devis-factures'],
            ['POST', '/api/Prospection/Search-Stream', 'prospection'],
            ['DELETE', '/api/wa/contacts/42/', 'crm'],
        ];
        for (const [methode, chemin, feature] of cas) {
            const res = await appel(methode, chemin);
            expect(res.status, `${methode} ${chemin}`).toBe(403);
            if (methode !== 'HEAD') expect((await res.json()).feature, `${methode} ${chemin}`).toBe(feature);
        }
    });

    it('le flux SSE des commandes, authentifié par ?token=, est refusé aussi', async () => {
        const res = await fetch(`${base}/api/orders/stream/test-1?token=${token}`);
        expect(res.status).toBe(403);
        expect((await res.json()).feature).toBe('commandes');
    });

    it('le contrôle vient après l\'authentification : sans jeton, 401 et rien n\'est révélé', async () => {
        const res = await appel('GET', '/api/documents', { avecJeton: false });
        expect(res.status).toBe(401);
    });

    it('le noyau n\'est pas concerné', async () => {
        expect((await appel('GET', '/api/health')).status).toBe(200);
        expect((await appel('GET', '/api/features')).status).toBe(200);
    });

    it('règle 5.2 : aucun routeur de fonctionnalité éteinte n\'a été chargé', () => {
        expect(errOutput).not.toMatch(/\[Marketplace\] Routeur de « [^»]+ » chargé à la demande/);
    });

    it('réactivée, une fonctionnalité répond de nouveau, et son routeur se charge à ce moment-là', async () => {
        // Routes sans effet de bord, une par routeur chargé à la demande.
        const lectures = [
            ['prospection', '/api/prospection/goafrica-metadata'],
            ['redaction', '/api/documents'],
            ['devis-factures', '/api/invoices'],
            ['commandes', '/api/orders/listen/status'],
        ];
        // redaction dépend d'agents, dont le routeur est mixte (chargé au démarrage).
        await basculer('agents', true);
        for (const [id, chemin] of lectures) {
            await basculer(id, true);
            const res = await appel('GET', chemin);
            expect(res.status, `${chemin} : ${await res.clone().text()}`).not.toBe(403);
            expect(res.status, chemin).toBeLessThan(500);
            expect(errOutput).toContain(`[Marketplace] Routeur de « ${id} » chargé à la demande.`);
        }
        // pipeline dépend de prospection, crm et agents.
        await basculer('crm', true);
        await basculer('pipeline', true);
        const res = await appel('GET', '/api/pipeline/runs');
        expect(res.status).toBeLessThan(500);
        expect(errOutput).toContain('[Marketplace] Routeur de « pipeline » chargé à la demande.');
    }, 60000);
});
