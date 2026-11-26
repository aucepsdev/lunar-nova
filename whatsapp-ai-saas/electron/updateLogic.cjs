/**
 * Logique pure de mise à jour — extraite de electron/updater.cjs pour être
 * testable unitairement (sans dépendance à Electron).
 */

/**
 * Compare deux versions sémantiques « x.y.z ». Retire un préfixe 'v' éventuel
 * et n'extrait que la partie numérique pure (les suffixes de pré-release
 * « 1.42.11-beta.1 » sont ignorés → comparés comme « 1.42.11 »).
 * @returns {number} 1 si v1 > v2, -1 si v1 < v2, 0 si égales.
 */
function compareVersions(v1, v2) {
    const extract = (v) => {
        const cleaned = String(v).replace(/^v/i, '').match(/\d+(?:\.\d+)*/);
        return (cleaned ? cleaned[0] : '0').split('.').map(n => parseInt(n, 10) || 0);
    };
    const p1 = extract(v1);
    const p2 = extract(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

/**
 * Normalise le tag d'une release GitHub (« v1.2.3 » → « 1.2.3 »).
 * Ne retire que le préfixe 'v' — l'ancien replace('v','') retirait tous les 'v'.
 */
function parseReleaseTag(tag) {
    return String(tag || '').replace(/^v/i, '');
}

// Dépôt des releases. Toute URL de téléchargement doit en provenir.
const RELEASES_OWNER = 'auceps-dev-team';
const RELEASES_REPO = 'wacopilote-releases';

// Installeur Windows attendu : l'artefact NSIS (build.nsis.artifactName dans
// package.json, « ${productName}_Setup.${ext} »). C'est le seul que l'updater
// sait installer en silencieux (option /S). Une release peut contenir d'autres
// .exe — la 1.49.0 publie aussi l'installeur Inno Setup « WaCopilote.1.49.0.exe »,
// que /S ne rend pas silencieux et qui installe ailleurs : prendre le premier
// .exe venu, comme auparavant, choisissait celui-là.
const WINDOWS_INSTALLER_NAME = 'WaCopilote_Setup.exe';

/**
 * Sélectionne l'asset de mise à jour correspondant à la plateforme courante.
 * Windows : l'installeur NSIS désigné par son nom, et lui seul. macOS et Linux
 * reçoivent l'artefact adapté (.dmg/.zip et .AppImage/.deb) et l'ouvrent pour
 * une installation manuelle guidée.
 */
function pickAssetForPlatform(assets, platform = process.platform) {
    const list = (assets || []).filter(a => a && a.name);
    if (platform === 'win32') {
        const found = list.find(a => a.name.toLowerCase() === WINDOWS_INSTALLER_NAME.toLowerCase());
        return { asset: found || null, platform };
    }
    const patterns = {
        darwin: ['.dmg', '.zip'],
        linux: ['.appimage', '.deb'],
    };
    for (const ext of patterns[platform] || []) {
        const found = list.find(a => a.name.toLowerCase().endsWith(ext));
        if (found) return { asset: found, platform };
    }
    return { asset: null, platform };
}

/**
 * Vrai si l'URL désigne un fichier de release du dépôt officiel, en HTTPS.
 * Auparavant, tout chemin sur github.com ou *.githubusercontent.com était
 * accepté, quel que soit le dépôt.
 */
function isTrustedReleaseDownloadUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:'
            && u.hostname === 'github.com'
            && !u.username && !u.password
            && u.pathname.startsWith(`/${RELEASES_OWNER}/${RELEASES_REPO}/releases/download/`);
    } catch {
        return false;
    }
}

/**
 * Extrait l'empreinte SHA-256 (hex minuscule) du champ `digest` qu'expose
 * l'API GitHub pour chaque asset (« sha256:<64 hex> »). Null si absente ou
 * dans un autre format — les assets téléversés avant mi-2025 n'en ont pas.
 */
function parseSha256Digest(digest) {
    const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''));
    return match ? match[1].toLowerCase() : null;
}

/**
 * Compare un fichier téléchargé à ce qu'annonce la release.
 * @returns {string|null} null si conforme, sinon la raison du refus.
 */
function checkDownloadedFile(actual, expected) {
    if (!expected || !expected.sha256) {
        return 'Aucune empreinte de référence : installation refusée.';
    }
    if (typeof expected.size === 'number' && expected.size > 0 && actual.size !== expected.size) {
        return `Taille inattendue (${actual.size} octets au lieu de ${expected.size}).`;
    }
    if (String(actual.sha256 || '').toLowerCase() !== expected.sha256) {
        return 'Empreinte SHA-256 différente de celle publiée avec la release.';
    }
    return null;
}

/** Calcule l'empreinte SHA-256 (hex) et la taille d'un fichier. */
function hashFile(filePath) {
    const fs = require('fs');
    const crypto = require('crypto');
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        let size = 0;
        fs.createReadStream(filePath)
            .on('data', (chunk) => { hash.update(chunk); size += chunk.length; })
            .on('error', reject)
            .on('end', () => resolve({ sha256: hash.digest('hex'), size }));
    });
}

module.exports = {
    RELEASES_OWNER,
    RELEASES_REPO,
    WINDOWS_INSTALLER_NAME,
    compareVersions,
    parseReleaseTag,
    pickAssetForPlatform,
    isTrustedReleaseDownloadUrl,
    parseSha256Digest,
    checkDownloadedFile,
    hashFile
};
