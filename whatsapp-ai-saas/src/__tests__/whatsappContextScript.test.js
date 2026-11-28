// Lecture de la conversation par le copilote (26/11/2026). Le script est
// construit avec le VRAI code de préparation du backend (inPageSelectors,
// sérialisé comme le fait GET /api/wa/selectors), puis évalué dans jsdom sur
// un DOM synthétique — aucune capture d'une vraie conversation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import { buildContextExtractionScript } from '../utils/whatsappContextScript';

const require = createRequire(import.meta.url);
const sel = require('../../backend/wa/waSelectors');

const registre = (distants) => {
    const page = sel.createSelectorRegistry({ dataDir: os.tmpdir(), cles: [] }).forPage();
    if (distants) page.lists = sel.mergeSelectors(distants);
    return { helper: sel.inPageSelectors.toString(), page };
};
const lire = (html, reg = registre()) => {
    document.body.innerHTML = html;
    // eval indirect : portée globale, comme executeJavaScript dans la webview.
    return (0, eval)(buildContextExtractionScript(reg));
};

describe('script de contexte du copilote', () => {
    it('lit le contact et les messages, et attribue chaque message au bon côté', async () => {
        const r = await lire(`
            <div id="pane-side"></div>
            <div id="main">
              <header><span data-testid="conversation-info-header-chat-title" title="Awa Boutique">Awa Boutique</span></header>
              <div data-id="false_22500000000@c.us_A"><span class="selectable-text">Bonjour, le bazin est dispo ?</span></div>
              <div data-id="true_22500000000@c.us_B"><span class="selectable-text">Oui, en trois couleurs.</span></div>
            </div>`);
        expect(r.error).toBeUndefined();
        expect(r.contactName).toBe('Awa Boutique');
        expect(r.messages.map(({ sender, text }) => ({ sender, text }))).toEqual([
            { sender: 'Awa Boutique', text: 'Bonjour, le bazin est dispo ?' },
            { sender: 'You', text: 'Oui, en trois couleurs.' },
        ]);
        expect(r.debug).toMatchObject({ strategyUsed: 'data-id', hasMainPanel: true, hasPaneSide: true, selectorsVersion: 0 });
    });

    it('un en-tête renommé par WhatsApp : « Unknown » avec les livrés, retrouvé avec un fichier distant', async () => {
        const html = `
            <div id="main">
              <header><span data-testid="chat-title-v2" title="Kouassi">Kouassi</span></header>
              <div data-id="false_1@c.us_A"><span class="selectable-text">Je prends deux</span></div>
            </div>`;
        expect((await lire(html)).contactName).toBe('Unknown');
        const r = await lire(html, registre({ copilotHeaderTitle: ['[data-testid="chat-title-v2"]'] }));
        expect(r.contactName).toBe('Kouassi');
        expect(r.messages[0]).toMatchObject({ sender: 'Kouassi', text: 'Je prends deux' });
    });

    it('un candidat distant invalide ne casse pas la lecture', async () => {
        const r = await lire(
            '<div id="main"><div data-id="false_1@c.us_A"><span class="selectable-text">Prix ?</span></div></div>',
            registre({ copilotMessageText: ['span[[cassé'] })
        );
        expect(r.error).toBeUndefined();
        expect(r.messages.map((m) => m.text)).toEqual(['Prix ?']);
    });

    it('repli sur les lignes ARIA hors liste de conversations quand rien d\'autre ne répond', async () => {
        const r = await lire(`
            <div id="pane-side"><div role="row"><span dir="ltr">Liste : à ignorer</span></div></div>
            <div id="main"><div role="row"><span dir="ltr">Message ouvert</span></div></div>`);
        expect(r.debug.strategyUsed).toBe('aria-row');
        expect(r.messages.map((m) => m.text)).toEqual(['Message ouvert']);
    });
});

// Format de WhatsApp Web mesuré le 28/11/2026 sur une session réelle (structure
// seulement, textes inventés) : div[role=row] > div[data-id] sans préfixe
// true_/false_ > div[data-virtualized] > [data-testid=msg-container], sans les
// classes message-in/message-out. Pointe de bulle (tail-out / tail-in) au
// premier message d'une série ; coche (svg dans msg-meta) sur les envoyés.
const ligne2026 = ({ id, cote, pointe = false, coche = false, etoile = false, texte }) => `
    <div role="row"><div data-id="${id}" data-testid="conv-msg-${id}"><div data-virtualized="false">
      ${pointe ? `<span data-testid="tail-${cote}" data-icon="tail-${cote}"><svg><title>tail-${cote}</title></svg></span>` : ''}
      <div data-testid="msg-container">
        <div class="copyable-text" data-pre-plain-text="[10:01, 28/11/2026] Auteur: "><span class="selectable-text copyable-text">${texte}</span></div>
        <div data-testid="msg-meta"><span>10:01</span>${coche ? '<span><svg><title>wds-ic-read</title></svg></span>' : ''}${etoile ? '<span><svg><title>ic-star</title></svg></span>' : ''}</div>
      </div>
    </div></div></div>`;
const conversation2026 = (lignes) => `
    <div id="pane-side"><div role="row"><span dir="ltr">Liste : à ignorer</span></div></div>
    <div id="main">
      <header><span data-testid="conversation-info-header-chat-title" title="Awa Boutique">Awa Boutique</span></header>
      ${lignes.map(ligne2026).join('')}
    </div>`;

describe('script de contexte du copilote — format de WhatsApp Web du 28/11/2026', () => {
    it('attribue chaque message au bon côté, pointe de bulle ou non', async () => {
        const r = await lire(conversation2026([
            { id: '3EB0A1', cote: 'in', pointe: true, texte: 'Bonjour, le bazin est dispo ?' },
            // Reçu, sans pointe (même série), avec une étoile dans msg-meta :
            // il hérite du sens du message précédent, l'étoile n'en fait pas un envoyé.
            { id: '3EB0A2', cote: 'in', etoile: true, texte: 'Et le wax ?' },
            { id: '3EB0A3', cote: 'out', pointe: true, coche: true, texte: 'Oui, en trois couleurs.' },
            { id: '3EB0A4', cote: 'out', coche: true, texte: 'Je vous envoie les photos demain.' },
            { id: '3EB0A5', cote: 'in', pointe: true, texte: 'D\'accord, merci' },
        ]));
        expect(r.error).toBeUndefined();
        expect(r.messages.map(({ sender, text }) => ({ sender, text }))).toEqual([
            { sender: 'Awa Boutique', text: 'Bonjour, le bazin est dispo ?' },
            { sender: 'Awa Boutique', text: 'Et le wax ?' },
            { sender: 'You', text: 'Oui, en trois couleurs.' },
            { sender: 'You', text: 'Je vous envoie les photos demain.' },
            { sender: 'Awa Boutique', text: 'D\'accord, merci' },
        ]);
        expect(r.debug).toMatchObject({ strategyUsed: 'aria-row', outCount: 2, unknownSideCount: 0 });
    });

    it('fenêtre commencée en milieu de série : la coche décide, sinon le message reste au contact', async () => {
        const r = await lire(conversation2026([
            { id: '3EB0B1', cote: 'out', coche: true, texte: 'Livraison prévue jeudi.' },
            { id: '3EB0B2', cote: 'in', pointe: true, texte: 'Parfait' },
        ]));
        expect(r.messages.map((m) => m.sender)).toEqual(['You', 'Awa Boutique']);

        const sansIndice = await lire(conversation2026([{ id: '3EB0C1', cote: 'in', texte: 'Combien ?' }]));
        expect(sansIndice.messages.map((m) => m.sender)).toEqual(['Awa Boutique']);
        expect(sansIndice.debug.unknownSideCount).toBe(1);
    });

    it('conversation avec soi-même : tous les messages sont du compte', async () => {
        const r = await lire(conversation2026([
            { id: '3EB0D1', cote: 'out', pointe: true, coche: true, texte: 'Relancer Awa jeudi' },
            { id: '3EB0D2', cote: 'out', coche: true, texte: 'Stock bazin : 12' },
            { id: '3EB0D3', cote: 'out', coche: true, texte: 'Devis Kouassi' },
        ]));
        expect(r.messages.map((m) => m.sender)).toEqual(['You', 'You', 'You']);
    });
});
