const geminiService = require('./geminiService');
const openrouterService = require('./openrouterService');
const ollamaService = require('./ollamaService');
const openaiService = require('./openaiService');
// nvidiaModels may be edited at runtime; load dynamically to pick changes without restart
function getNvidiaModels() {
    try {
        delete require.cache[require.resolve('./nvidiaModels')];
    } catch {
        // ignore
    }
    return require('./nvidiaModels');
}
const db = require('./db');

/**
 * Résolution de clé NVIDIA à 3 niveaux :
 *   1. Clé spécifique au modèle en DB (configurée par l'utilisateur)
 *   2. Clé globale openai_api_key en DB
 *   3. Clé système dans .env (fallback silencieux)
 */
async function resolveNvidiaKey(modelId) {
    const nvidiaModels = getNvidiaModels();
    return nvidiaModels.resolveKey(modelId, db.getSetting.bind(db));
}

async function getProviderConfig(personaId = null) {
    let provider = await db.getSetting('default_ai_provider', 'gemini');
    let dbAgent = null;

    if (personaId) {
        dbAgent = await db.getAgent(personaId);
        if (dbAgent && dbAgent.provider_override) {
            provider = dbAgent.provider_override;
        }
    }

    return { provider, dbAgent };
}

async function generateProposals(chatContext, modelParam, providerOverride = null) {
    const { provider: defaultProvider } = await getProviderConfig(null);
    const provider = providerOverride || defaultProvider;

    try {
        if (provider === 'openrouter') {
            const apiKey = await db.getSetting('openrouter_api_key', '');
            if (!apiKey && !process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter API key not configured');
            return await openrouterService.generateProposals(chatContext, modelParam, apiKey);
        } else if (provider === 'ollama') {
            const apiKey = await db.getSetting('ollama_api_key', '');
            return await ollamaService.generateProposals(chatContext, modelParam, apiKey);
        } else if (provider === 'openai') {
            const apiKey = await resolveNvidiaKey(modelParam);
            if (!apiKey) throw new Error('OpenAI/NVIDIA API key not configured');
            const nvidiaModels = getNvidiaModels();
            let baseURL = await db.getSetting('openai_base_url', nvidiaModels.NVIDIA_BASE_URL);
            const modelDef = nvidiaModels.getModelDef(modelParam);
            if (modelDef && modelDef.provider === 'together') {
                baseURL = 'https://api.together.xyz/v1';
            }
            return await openaiService.generateProposals(chatContext, modelParam, apiKey, baseURL);
        } else {
            return await geminiService.generateProposals(chatContext, modelParam);
        }
    } catch (err) {
        console.error(`[aiController] Fallback sur Gemini pour generateProposals suite à l'erreur (${provider}) :`, err.message);
        return await geminiService.generateProposals(chatContext, modelParam);
    }
}

/**
 * classifyOrderIntent — classification structurée à un seul message pour
 * l'agent "Order Radar" (détection d'intention d'achat / commande directe).
 * Même branchement par provider que generateProposals, pour que le classificateur
 * respecte le provider/clé réellement configurés au lieu d'appeler un SDK en dur.
 */
async function classifyOrderIntent(text, contactName, modelParam = null, providerOverride = null) {
    const { provider: defaultProvider } = await getProviderConfig(null);
    const provider = providerOverride || defaultProvider;

    try {
        if (provider === 'openrouter') {
            const apiKey = await db.getSetting('openrouter_api_key', '');
            if (!apiKey && !process.env.OPENROUTER_API_KEY) throw new Error('OpenRouter API key not configured');
            return await openrouterService.classifyOrderIntent(text, contactName, apiKey, modelParam);
        } else if (provider === 'ollama') {
            const apiKey = await db.getSetting('ollama_api_key', '');
            return await ollamaService.classifyOrderIntent(text, contactName, apiKey, modelParam);
        } else if (provider === 'openai') {
            const apiKey = await resolveNvidiaKey(modelParam);
            if (!apiKey) throw new Error('OpenAI/NVIDIA API key not configured');
            const nvidiaModels = getNvidiaModels();
            let baseURL = await db.getSetting('openai_base_url', nvidiaModels.NVIDIA_BASE_URL);
            const modelDef = nvidiaModels.getModelDef(modelParam);
            if (modelDef && modelDef.provider === 'together') {
                baseURL = 'https://api.together.xyz/v1';
            }
            return await openaiService.classifyOrderIntent(text, contactName, apiKey, baseURL, modelParam);
        } else {
            return await geminiService.classifyOrderIntent(text, contactName, modelParam);
        }
    } catch (err) {
        console.error(`[aiController] Fallback sur Gemini pour classifyOrderIntent suite à l'erreur (${provider}) :`, err.message);
        return await geminiService.classifyOrderIntent(text, contactName, modelParam);
    }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.untrustedInput=false] Le message contient du contenu
 *   tiers (message WhatsApp d'un client, données récupérées sur le web). Les
 *   canaux d'agents locaux (CLI Claude/Gemini, serveur MCP) sont alors exclus :
 *   ces outils lisent le disque, et un texte tiers pourrait leur dicter quoi
 *   lire.
 */
async function chatWithAgent(personaId, message, imageParams, attachments, promptFormat, messages = null, currentTasks = null, isRealTime = false, modelOverride = null, providerOverride = null, options = {}) {
    const { provider: dbProvider, dbAgent } = await getProviderConfig(personaId);
    let provider = providerOverride || dbProvider;

    // Process attachments
    let processedMessage = message || '';
    let processedImageParams = imageParams;
    let hasAudio = false;

    if (attachments && attachments.length > 0) {
        let pdfText = '';
        const pdfParse = require('pdf-parse');
        
        for (const att of attachments) {
            if (att.mimeType.startsWith('image/')) {
                if (!processedImageParams) {
                    const base64Data = att.data.includes(',') ? att.data.split(',')[1] : att.data;
                    processedImageParams = { data: base64Data, mimeType: att.mimeType };
                }
            } else if (att.mimeType === 'application/pdf') {
                try {
                    const base64Data = att.data.includes(',') ? att.data.split(',')[1] : att.data;
                    const buffer = Buffer.from(base64Data, 'base64');
                    const pdfData = await pdfParse(buffer);
                    pdfText += `\n\n--- Content of ${att.fileName || 'document.pdf'} ---\n${pdfData.text}\n`;
                } catch (e) {
                    console.error('PDF Parse Error:', e);
                }
            } else if (att.mimeType.startsWith('audio/')) {
                hasAudio = true;
            }
        }

        // Only append pdfText if not using Gemini, since Gemini reads PDFs natively when passed as attachments
        if (pdfText && provider !== 'gemini') {
            processedMessage += pdfText;
        }

        // Force fallback to Gemini if audio is present
        if (hasAudio && provider === 'openai') {
            provider = 'gemini'; 
            console.error('[aiController] Audio attachment detected -> falling back to Gemini');
        }
    }

    const { executeAgentWithFallback } = require('./services/agentFallbackRouter');
    return await executeAgentWithFallback({
        personaId,
        message: processedMessage,
        imageParams: processedImageParams,
        attachments,
        promptFormat,
        messages,
        currentTasks,
        isRealTime,
        modelOverride,
        providerOverride: provider,
        dbAgent,
        untrustedInput: Boolean(options && options.untrustedInput)
    });
}

async function listModels(providerOverride = null, apiKeyOverride = null) {
    const provider = providerOverride || await db.getSetting('default_ai_provider', 'gemini');

    if (provider === 'openrouter') {
        const apiKey = apiKeyOverride || await db.getSetting('openrouter_api_key', '');
        return await openrouterService.listModels(apiKey);
    } else if (provider === 'ollama') {
        const apiKey = apiKeyOverride || await db.getSetting('ollama_api_key', '');
        return await ollamaService.listModels(apiKey);
    } else if (provider === 'openai') {
        // Retourner le catalogue statique NVIDIA/Together AI
        // (évite une requête API qui nécessiterait une clé NVIDIA valide)
        const nm = getNvidiaModels();
        const chatModels = nm.getModelsByType('text').concat(nm.getModelsByType('vision'))
            .map(m => ({ id: m.id, name: m.name, type: m.type }));
        return { chat: chatModels };
    } else {
        return await geminiService.listModels();
    }
}


module.exports = {
    generateProposals,
    chatWithAgent,
    listModels,
    classifyOrderIntent
};
