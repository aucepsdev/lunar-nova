/**
 * Script de lecture de la conversation ouverte, exécuté dans la webview
 * WhatsApp pour le copilote (lecture seule : aucun clic, aucune saisie).
 *
 * Sorti de WorkArea.jsx le 26/11/2026 pour être testé (il n'avait aucun
 * test), et pour recevoir les sélecteurs du registre du backend
 * (backend/wa/waSelectors.js) au lieu de les écrire en dur.
 *
 * @param {{ helper: string, page: object }} registre réponse de GET /api/wa/selectors :
 *   `page` est une DONNÉE, insérée comme littéral JSON ; `helper` est le code
 *   de préparation du backend lui-même (inPageSelectors), jamais un contenu du
 *   fichier distant.
 * @returns {string} expression à passer à webview.executeJavaScript ; elle rend
 *   { contactName, messages, debug } ou { error }.
 */
export function buildContextExtractionScript(registre) {
    return `
            (async function() {
                try {
                    const result = { contactName: 'Unknown', messages: [], debug: {} };
                    const sel = (${registre.helper})(${JSON.stringify(registre.page)});

                    const headerTitle = sel.first(document, 'copilotHeaderTitle');
                    if (headerTitle) result.contactName = (headerTitle.getAttribute('title') || headerTitle.textContent || '').trim() || 'Unknown';

                    // Trois façons de trouver les messages, des anciennes versions de WhatsApp Web à la
                    // version actuelle : data-id préfixé true_/false_, puis classes message-in/message-out,
                    // puis lignes role="row" du panneau. Mesuré le 28/11/2026 sur une session réelle :
                    // les deux premières ne trouvent plus rien, et les messages sont des
                    // div[role=row] > div[data-id] (sans préfixe) > … > [data-testid=msg-container].
                    // Le sens de chaque message est décidé plus bas par sel.sens.
                    let messageNodes = Array.from(document.querySelectorAll('[data-id]')).filter(el => {
                        const id = el.getAttribute('data-id');
                        return id && (id.startsWith('true_') || id.startsWith('false_'));
                    });
                    result.debug.dataIdCount = messageNodes.length;

                    if (messageNodes.length === 0) {
                        messageNodes = Array.from(document.querySelectorAll(sel.S.copilotLegacyMessage));
                        result.debug.legacyClassCount = messageNodes.length;
                    }

                    if (messageNodes.length === 0) {
                        const mainPanel = sel.first(document, 'copilotMainPanel') || document.body;
                        messageNodes = Array.from(mainPanel.querySelectorAll(sel.S.messageRow)).filter(el => !el.closest(sel.S.chatListPane));
                        result.debug.ariaRowCount = messageNodes.length;
                    }

                    result.debug.strategyUsed = result.debug.dataIdCount > 0 ? 'data-id'
                        : (result.debug.legacyClassCount > 0 ? 'legacy-class'
                        : (result.debug.ariaRowCount > 0 ? 'aria-row' : 'none'));
                    result.debug.hasMainPanel = !!sel.first(document, 'copilotMainPanel');
                    result.debug.hasPaneSide = !!document.querySelector(sel.S.chatListPane);
                    result.debug.selectorsVersion = ${Number(registre.page.version) || 0};

                    messageNodes = messageNodes.slice(-15);
                    let imageCount = 0;
                    let outCount = 0;
                    let unknownSideCount = 0;

                    for (const node of messageNodes) {
                        const textNode = node.querySelector(sel.S.copilotMessageText);
                        const timeNode = node.querySelector(sel.S.copilotMessageTime);
                        const imgNode = node.querySelector('img[src^="blob:"]');

                        let text = textNode ? textNode.textContent : (node.innerText || '').trim();
                        let mediaData = null;

                        if (imgNode && imageCount < 2) {
                            try {
                                const res = await fetch(imgNode.src);
                                const blob = await res.blob();
                                mediaData = await new Promise((resolve, reject) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(reader.result);
                                    reader.onerror = reject;
                                    reader.readAsDataURL(blob);
                                });
                                imageCount++;
                            } catch (e) {
                                console.error('Error fetching image blob', e);
                            }
                        }

                        if ((text && text.length > 0) || mediaData) {
                            // Qui a écrit ce message : sel.sens (inPageSelectors, backend/wa/waSelectors.js),
                            // partagé avec l'observateur de commandes. Jusqu'au 28/11/2026, ce bloc lisait
                            // le préfixe true_/false_ du data-id, puis comparait le centre de la ligne à
                            // celui du panneau. Mesuré ce jour-là sur une session réelle : le préfixe a
                            // disparu, la ligne occupe toute la largeur, et les 7 messages d'une
                            // conversation client étaient tous attribués au client, dont 2 envoyés.
                            const side = typeof sel.sens === 'function' ? sel.sens(node) : null;
                            if (side === null) unknownSideCount++;
                            const isOut = side === 'out';
                            if (isOut) outCount++;

                            result.messages.push({
                                sender: isOut ? 'You' : result.contactName,
                                text: text || '[Image]',
                                media: mediaData,
                                time: timeNode ? (timeNode.parentElement?.textContent || timeNode.textContent || 'Unknown') : 'Unknown'
                            });
                        }
                    }
                    result.debug.outCount = outCount;
                    result.debug.unknownSideCount = unknownSideCount;
                    result.debug.totalCount = result.messages.length;
                    return result;
                } catch (e) {
                    return { error: e.toString() };
                }
            })();
`;
}
