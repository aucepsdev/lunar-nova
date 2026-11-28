// @vitest-environment node
//
// Tâches de fond des commandes et des notes vocales (Marketplace, ticket #30,
// PR 2, §4.5 : « désactiver commandes arrête les écoutes en cours,
// désactiver notes-vocales vide la file »).
//
// Le pilote WhatsApp est remplacé par une fausse page
// (`__setWaDriverForTests`) : aucun navigateur, aucune webview. Le routeur
// des commandes est monté seul, sans le contrôle des routes, pour observer
// l'état des écoutes même une fois la fonctionnalité éteinte.
//
// Convention du projet : require, jamais import, pour partager les instances.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';

const db = require('../db');
const features = require('../features');
const waDriver = require('../wa/waDriver');
const voiceNoteService = require('../services/voiceNoteService');

function faussePage() {
    const page = {
        exposees: {},
        evaluations: [],
        // Sélecteur « application prête » : la fausse page n'a pas de WhatsApp,
        // l'attente échoue et l'écouteur s'injecte quand même (chemin prévu).
        evaluateWithSelectors: vi.fn(async () => '#app'),
        waitForSelector: vi.fn(async () => { throw new Error('pas de WhatsApp dans ce test'); }),
        exposeFunction: vi.fn(async (nom, fn) => { page.exposees[nom] = fn; }),
        evaluate: vi.fn(async (fn) => { page.evaluations.push(String(fn)); }),
        onClose: vi.fn(),
    };
    return page;
}

describe('orderListener — arrêt des tâches de fond à la désactivation', () => {
    let server;
    let base;
    const pages = new Map();
    const extractionOriginale = voiceNoteService.extractVoiceNoteFromPage;

    const post = (chemin, corps) => fetch(`${base}/api/orders${chemin}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps)
    });
    const ecoutes = async () => (await (await fetch(`${base}/api/orders/listen/status`)).json()).active_listeners;

    beforeAll(async () => {
        db.__setDbFileForTests(':memory:');
        expect(await db.initDB()).toBe(true);
        waDriver.__setWaDriverForTests({
            kind: 'test',
            findPages: async (instanceId) => {
                if (!pages.has(instanceId)) pages.set(instanceId, faussePage());
                return [pages.get(instanceId)];
            }
        });
        const app = express();
        app.use(express.json());
        app.use('/api/orders', require('../orderListener').creerRouteur());
        await new Promise((resolve) => {
            server = http.createServer(app).listen(0, '127.0.0.1', () => {
                base = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    }, 30000);

    afterAll(async () => {
        voiceNoteService.extractVoiceNoteFromPage = extractionOriginale;
        waDriver.__setWaDriverForTests(null);
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('éteindre commandes détache les écoutes en cours et ferme les flux SSE', async () => {
        expect((await post('/listen/start', { instance_id: 'wa-1' })).status).toBe(200);
        expect(await ecoutes()).toEqual(['wa-1']);

        // Un client du flux SSE, comme l'écran des commandes.
        const fermeture = new Promise((resolve, reject) => {
            http.get(`${base}/api/orders/stream/wa-1`, (res) => {
                res.resume();
                res.on('end', () => resolve('fin'));
                res.on('close', () => resolve('fermé'));
            }).on('error', reject);
        });
        await new Promise((r) => setTimeout(r, 100));

        await features.definir('commandes', false);

        expect(await ecoutes()).toEqual([]);
        // L'observateur ET le poller ont été retirés de la page.
        const detachement = pages.get('wa-1').evaluations.find((f) => f.includes('__iol_observer'));
        expect(detachement).toMatch(/__iol_poller/);
        await expect(Promise.race([fermeture, new Promise((r) => setTimeout(() => r('toujours ouvert'), 2000))]))
            .resolves.not.toBe('toujours ouvert');

        await features.definir('commandes', true);
    });

    it('un vocal n\'est pris en charge que si notes-vocales est active', async () => {
        voiceNoteService.extractVoiceNoteFromPage = vi.fn(async () => { throw new Error('extraction simulée'); });
        expect((await post('/listen/start', { instance_id: 'wa-2' })).status).toBe(200);
        const signalerVocal = pages.get('wa-2').exposees.onNewWaVoiceNote;
        const laisserPasser = () => new Promise((r) => setTimeout(r, 50));

        expect(await features.estActive('notes-vocales')).toBe(false);
        signalerVocal('Aminata Koné', 'vocal-1');
        await laisserPasser();
        expect(voiceNoteService.extractVoiceNoteFromPage).not.toHaveBeenCalled();

        await features.definir('notes-vocales', true);
        signalerVocal('Aminata Koné', 'vocal-2');
        await laisserPasser();
        expect(voiceNoteService.extractVoiceNoteFromPage).toHaveBeenCalledTimes(1);

        await features.definir('notes-vocales', false);
        signalerVocal('Aminata Koné', 'vocal-3');
        await laisserPasser();
        expect(voiceNoteService.extractVoiceNoteFromPage).toHaveBeenCalledTimes(1);
    });
});
