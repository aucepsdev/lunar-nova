const { app, ipcMain, shell } = require('electron');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    RELEASES_OWNER,
    RELEASES_REPO,
    compareVersions,
    parseReleaseTag,
    pickAssetForPlatform,
    isTrustedReleaseDownloadUrl,
    parseSha256Digest,
    checkDownloadedFile,
    hashFile
} = require('./updateLogic.cjs');

const REPO_URL = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`;

// Timeouts réseau : l'API GitHub peut être lente ou saturée ; un handler IPC
// ne doit jamais rester bloqué indéfiniment. Le téléchargement (fichier de
// ~160 Mo) reçoit une marge plus généreuse.
const CHECK_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// État tenu par le processus principal, et non par le renderer.
//
// Le renderer transmettait l'URL à télécharger puis le chemin à exécuter : un
// renderer compromis (XSS) pouvait faire télécharger et lancer en silencieux
// n'importe quel exécutable hébergé sur github.com. Désormais, le processus
// principal ne télécharge que l'asset qu'il a lui-même retenu lors de la
// vérification, et n'exécute que le fichier dont il a vérifié l'empreinte.
let pendingUpdate = null;      // { version, url, name, size, sha256 }
let verifiedInstaller = null;  // { path, sha256, size }

function discardVerifiedInstaller() {
    if (verifiedInstaller) {
        try { fs.unlinkSync(verifiedInstaller.path); } catch { /* déjà supprimé */ }
    }
    verifiedInstaller = null;
}

/**
 * @param {() => Electron.BrowserWindow | undefined} getMainWindow
 *
 * Un accesseur, et non la fenêtre elle-même : setupUpdater est appelé avant
 * createWindow, donc recevoir `mainWindow` directement revenait à capturer
 * `undefined` pour toute la durée de vie de l'application. La garde
 * `if (mainWindow && ...)` n'était alors jamais vraie et aucun événement de
 * progression n'atteignait l'interface — la barre restait figée à 0 %.
 * L'accesseur résout la fenêtre au moment de l'envoi, et reste valide si elle
 * est recréée (réactivation sous macOS).
 */
module.exports = function setupUpdater(getMainWindow) {
    // 0. OBTENTION DE LA VERSION LOCALE
    ipcMain.handle('update:get-version', () => {
        return app.getVersion();
    });

    // 1. VÉRIFICATION DE LA VERSION
    ipcMain.handle('update:check', async () => {
        try {
            // User-Agent explicite : l'API GitHub le requiert (il était envoyé
            // par défaut par axios, mais le rendre explicite évite les refus
            // et aide au diagnostic côté GitHub).
            const res = await axios.get(REPO_URL, {
                timeout: CHECK_TIMEOUT_MS,
                headers: {
                    'User-Agent': `WaCopilote/${app.getVersion()}`,
                    Accept: 'application/vnd.github+json',
                },
            });

            const latestVersion = parseReleaseTag(res.data.tag_name);
            const currentVersion = app.getVersion();
            const cmp = compareVersions(latestVersion, currentVersion);

            if (cmp > 0) {
                // Asset adapté à la plateforme. Il n'est proposé au
                // téléchargement que s'il vient du dépôt officiel et porte une
                // empreinte SHA-256 publiée par GitHub (champ `digest`) :
                // sans empreinte, rien ne permettrait de vérifier le fichier
                // avant de l'exécuter. Sinon, la mise à jour reste signalée
                // (note de version) sans bouton de téléchargement.
                const { asset, platform } = pickAssetForPlatform(res.data.assets);
                const sha256 = asset ? parseSha256Digest(asset.digest) : null;
                const downloadable = Boolean(asset && sha256 && isTrustedReleaseDownloadUrl(asset.browser_download_url));

                if (asset && !downloadable) {
                    console.error(`[Updater] Asset ${asset.name} non proposé : ${sha256 ? 'URL hors du dépôt officiel' : 'aucune empreinte SHA-256 publiée'}.`);
                }

                pendingUpdate = downloadable
                    ? { version: latestVersion, url: asset.browser_download_url, name: asset.name, size: asset.size, sha256 }
                    : null;

                return {
                    hasUpdate: true,
                    version: latestVersion,
                    currentVersion,
                    notes: res.data.body,
                    platform,
                    assetName: asset ? asset.name : null,
                    downloadUrl: pendingUpdate ? pendingUpdate.url : null,
                };
            }

            pendingUpdate = null;
            const result = { hasUpdate: false, latestVersion, currentVersion };

            // Cas « release derrière la version installée » : la comparaison
            // ne peut jamais signaler de mise à jour. Ce n'est pas une erreur
            // réseau, c'est un état de configuration des releases — on le
            // remonte pour que l'interface puisse l'expliquer clairement au
            // lieu d'afficher un « à jour » trompeur.
            if (cmp < 0) {
                result.info = 'release_behind_current';
            }
            return result;
        } catch (e) {
            console.error('[Updater] Erreur check update:', e.message);
            const isRateLimit = e.response && e.response.status === 403;
            const isNotFound = e.response && e.response.status === 404;
            return {
                hasUpdate: false,
                error: e.message,
                errorCode: isRateLimit ? 'RATE_LIMIT' : isNotFound ? 'REPO_NOT_FOUND' : 'NETWORK',
            };
        }
    });

    // 2. TÉLÉCHARGEMENT ET VÉRIFICATION
    ipcMain.handle('update:start-download', async (event, url) => {
        // Seul l'asset retenu par la dernière vérification peut être téléchargé.
        // L'URL reçue du renderer sert uniquement à confirmer qu'il s'agit bien
        // de celui-là.
        const target = pendingUpdate;
        if (!target || url !== target.url || !isTrustedReleaseDownloadUrl(target.url)) {
            return { success: false, error: 'Aucune mise à jour vérifiée ne correspond à ce téléchargement. Relancez la recherche de mises à jour.' };
        }

        discardVerifiedInstaller();

        const ext = path.extname(target.name) || '.exe';
        const tempPath = path.join(app.getPath('temp'), `WaCopilote-Update-${Date.now()}${ext}`);

        try {
            const response = await axios({
                method: 'GET',
                url: target.url,
                responseType: 'stream',
                timeout: DOWNLOAD_TIMEOUT_MS,
                // Les assets GitHub redirigent vers le CDN ; axios suit les
                // redirections par défaut. User-Agent explicite.
                headers: { 'User-Agent': `WaCopilote/${app.getVersion()}` },
            });

            const totalLength = parseInt(response.headers['content-length'], 10) || target.size || 0;
            const hash = crypto.createHash('sha256');
            let downloaded = 0;
            let lastPercent = 0;

            const writer = fs.createWriteStream(tempPath);
            response.data.pipe(writer);
            response.data.on('data', (chunk) => {
                hash.update(chunk);
                downloaded += chunk.length;

                const percent = totalLength > 0
                    ? Math.round((downloaded / totalLength) * 100)
                    : Math.min(99, Math.round((downloaded / (40 * 1024 * 1024)) * 100));

                // Throttling : on n'envoie au front que si le pourcentage change.
                if (percent > lastPercent) {
                    lastPercent = percent;
                    const win = getMainWindow();
                    if (win && !win.isDestroyed()) {
                        win.webContents.send('update:progress', percent);
                    }
                }
            });

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.on('error', reject);
            });

            // Vérification d'intégrité : taille et empreinte comparées à ce
            // que publie la release. Un fichier tronqué, altéré en transit ou
            // substitué est supprimé et jamais proposé à l'installation.
            const refusal = checkDownloadedFile(
                { sha256: hash.digest('hex'), size: downloaded },
                { sha256: target.sha256, size: target.size }
            );
            if (refusal) {
                try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
                console.error(`[Updater] Téléchargement rejeté : ${refusal}`);
                return { success: false, error: `Mise à jour rejetée : ${refusal}` };
            }

            verifiedInstaller = { path: tempPath, sha256: target.sha256, size: downloaded };
            return { success: true, filePath: tempPath };
        } catch (error) {
            // Nettoyage du fichier partiel en cas d'échec
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore */ }
            return { success: false, error: error.message };
        }
    });

    // 3. INSTALLATION / OUVERTURE DE L'ARTEFACT
    ipcMain.handle('update:install', async (event, filePath) => {
        // Seul le fichier téléchargé et vérifié par ce processus peut être
        // lancé. Auparavant, tout fichier du dossier temporaire était accepté.
        const installer = verifiedInstaller;
        if (!installer || path.resolve(String(filePath || '')) !== path.resolve(installer.path)) {
            return { success: false, error: 'Ce fichier n\'a pas été vérifié par WaCopilote : installation refusée.' };
        }

        // Nouvelle vérification juste avant l'exécution : le dossier
        // temporaire est accessible aux autres programmes de la session, le
        // fichier a pu être remplacé depuis le téléchargement.
        try {
            const refusal = checkDownloadedFile(await hashFile(installer.path), installer);
            if (refusal) {
                discardVerifiedInstaller();
                return { success: false, error: `Mise à jour rejetée : ${refusal}` };
            }
        } catch (e) {
            discardVerifiedInstaller();
            return { success: false, error: `Fichier de mise à jour illisible : ${e.message}` };
        }

        // Windows : installeur NSIS lancé en processus détaché, puis
        // fermeture de l'application pour libérer les fichiers en cours
        // d'utilisation (« Files in Use »).
        if (process.platform === 'win32') {
            const subprocess = spawn(installer.path, ['/S', '--force-run'], {
                detached: true,
                stdio: 'ignore'
            });
            subprocess.unref();
            app.quit();
            return { success: true };
        }

        // macOS / Linux : pas d'installation silencieuse fiable — on ouvre
        // l'artefact téléchargé (.dmg → Finder, .AppImage → exécutable, .deb
        // → installateur système) et on laisse l'utilisateur guider
        // l'installation. L'application ne se ferme pas.
        try {
            if (process.platform === 'linux' && installer.path.toLowerCase().endsWith('.appimage')) {
                fs.chmodSync(installer.path, 0o755);
            }
            const err = await shell.openPath(installer.path);
            return err
                ? { success: false, error: err }
                : { success: true, note: 'open' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
};
