// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
    compareVersions,
    parseReleaseTag,
    pickAssetForPlatform,
    isTrustedReleaseDownloadUrl,
    parseSha256Digest,
    checkDownloadedFile,
    hashFile
} from '../../electron/updateLogic.cjs';

describe('compareVersions', () => {
    it('compare des versions à 3 segments', () => {
        expect(compareVersions('1.42.11', '1.39.3')).toBe(1);
        expect(compareVersions('1.39.3', '1.42.11')).toBe(-1);
        expect(compareVersions('1.42.0', '1.42.0')).toBe(0);
    });

    it('ignore le préfixe v', () => {
        expect(compareVersions('v1.42.0', '1.42.0')).toBe(0);
        expect(compareVersions('V1.43.0', '1.42.0')).toBe(1);
    });

    it('gère des segments manquants', () => {
        expect(compareVersions('1.42', '1.42.0')).toBe(0);
        expect(compareVersions('1.42', '1.42.1')).toBe(-1);
    });

    it('gère les suffixes de pré-release (ignorés)', () => {
        expect(compareVersions('1.42.11-beta.1', '1.42.11')).toBe(0);
    });

    it('gère une entrée vide', () => {
        expect(compareVersions('', '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', '')).toBe(1);
    });
});

describe('parseReleaseTag', () => {
    it('retire uniquement le préfixe v', () => {
        expect(parseReleaseTag('v1.42.0')).toBe('1.42.0');
        expect(parseReleaseTag('1.39.3')).toBe('1.39.3');
    });

    it('ne retire pas les v internes (régression : replace("v","") le faisait)', () => {
        expect(parseReleaseTag('v1.4v2')).toBe('1.4v2');
    });

    it('gère une entrée vide', () => {
        expect(parseReleaseTag('')).toBe('');
        expect(parseReleaseTag(null)).toBe('');
    });
});

describe('pickAssetForPlatform', () => {
    const assets = [
        { name: 'WaCopilote_Setup.exe' },
        { name: 'WaCopilote-1.42.11.dmg' },
        { name: 'WaCopilote-1.42.11.AppImage' },
        { name: 'WaCopilote-1.42.11.deb' },
        { name: 'latest.yml' },
    ];

    it('sélectionne l\'exe sur Windows', () => {
        const { asset } = pickAssetForPlatform(assets, 'win32');
        expect(asset.name).toBe('WaCopilote_Setup.exe');
    });

    it('sélectionne le dmg sur macOS', () => {
        const { asset } = pickAssetForPlatform(assets, 'darwin');
        expect(asset.name).toBe('WaCopilote-1.42.11.dmg');
    });

    it('sélectionne l\'AppImage sur Linux', () => {
        const { asset } = pickAssetForPlatform(assets, 'linux');
        expect(asset.name).toBe('WaCopilote-1.42.11.AppImage');
    });

    it('renvoie null si aucun asset pour la plateforme', () => {
        const { asset } = pickAssetForPlatform([{ name: 'WaCopilote_Setup.exe' }], 'linux');
        expect(asset).toBeNull();
    });

    it('ignore les assets sans nom', () => {
        const { asset } = pickAssetForPlatform([{ label: 'x' }, { name: 'WaCopilote_Setup.exe' }], 'win32');
        expect(asset.name).toBe('WaCopilote_Setup.exe');
    });

    it('gère une liste vide', () => {
        const { asset } = pickAssetForPlatform([], 'win32');
        expect(asset).toBeNull();
    });
});

// ── S5 (docs/audit.md) : mises à jour vérifiées ─────────────────────────────

describe('pickAssetForPlatform — installeur Windows désigné par son nom', () => {
    it('choisit l\'installeur NSIS même si un autre .exe le précède (release 1.49.0)', () => {
        const assets = [{ name: 'WaCopilote.1.49.0.exe' }, { name: 'WaCopilote_Setup.exe' }];
        expect(pickAssetForPlatform(assets, 'win32').asset.name).toBe('WaCopilote_Setup.exe');
    });

    it('ne propose aucun asset si seul un autre .exe est publié', () => {
        expect(pickAssetForPlatform([{ name: 'WaCopilote.1.49.0.exe' }], 'win32').asset).toBeNull();
    });
});

describe('isTrustedReleaseDownloadUrl', () => {
    const official = 'https://github.com/auceps-dev-team/wacopilote-releases/releases/download/v1.49.0/WaCopilote_Setup.exe';

    it('accepte un fichier de release du dépôt officiel', () => {
        expect(isTrustedReleaseDownloadUrl(official)).toBe(true);
    });

    it('refuse un autre dépôt GitHub (accepté auparavant)', () => {
        expect(isTrustedReleaseDownloadUrl('https://github.com/attaquant/outil/releases/download/v1/WaCopilote_Setup.exe')).toBe(false);
    });

    it('refuse un retour en arrière dans le chemin', () => {
        expect(isTrustedReleaseDownloadUrl('https://github.com/auceps-dev-team/wacopilote-releases/releases/download/../../../attaquant/outil/releases/download/v1/x.exe')).toBe(false);
    });

    it('refuse HTTP, un autre hôte et un hôte déguisé par identifiants', () => {
        expect(isTrustedReleaseDownloadUrl(official.replace('https:', 'http:'))).toBe(false);
        expect(isTrustedReleaseDownloadUrl('https://objects.githubusercontent.com/auceps-dev-team/wacopilote-releases/releases/download/v1/x.exe')).toBe(false);
        expect(isTrustedReleaseDownloadUrl('https://github.com@exemple.org/auceps-dev-team/wacopilote-releases/releases/download/v1/x.exe')).toBe(false);
    });

    it('refuse une valeur qui n\'est pas une URL', () => {
        expect(isTrustedReleaseDownloadUrl(String.raw`C:\Temp\setup.exe`)).toBe(false);
        expect(isTrustedReleaseDownloadUrl(undefined)).toBe(false);
    });
});

describe('parseSha256Digest', () => {
    const hex = 'a24f952463737fa0841bc17067b3a8f9b12238812db1e4aa7fb3a7a5752e7004';

    it('extrait l\'empreinte du champ digest de l\'API GitHub', () => {
        expect(parseSha256Digest(`sha256:${hex}`)).toBe(hex);
        expect(parseSha256Digest(`sha256:${hex.toUpperCase()}`)).toBe(hex);
    });

    it('renvoie null sans empreinte exploitable', () => {
        expect(parseSha256Digest(null)).toBeNull();
        expect(parseSha256Digest('')).toBeNull();
        expect(parseSha256Digest(`sha1:${hex.slice(0, 40)}`)).toBeNull();
        expect(parseSha256Digest(`sha256:${hex.slice(0, 63)}`)).toBeNull();
    });
});

describe('checkDownloadedFile', () => {
    const expected = { sha256: 'ab'.repeat(32), size: 10 };

    it('accepte un fichier conforme', () => {
        expect(checkDownloadedFile({ sha256: 'AB'.repeat(32), size: 10 }, expected)).toBeNull();
    });

    it('refuse une taille différente', () => {
        expect(checkDownloadedFile({ sha256: 'ab'.repeat(32), size: 9 }, expected)).toMatch(/Taille inattendue/);
    });

    it('refuse une empreinte différente', () => {
        expect(checkDownloadedFile({ sha256: 'cd'.repeat(32), size: 10 }, expected)).toMatch(/Empreinte SHA-256 différente/);
    });

    it('refuse en l\'absence d\'empreinte de référence', () => {
        expect(checkDownloadedFile({ sha256: 'ab'.repeat(32), size: 10 }, { size: 10 })).toMatch(/Aucune empreinte/);
    });
});

describe('hashFile', () => {
    it('calcule l\'empreinte SHA-256 et la taille d\'un fichier', async () => {
        const file = path.join(os.tmpdir(), `wacopilote-hash-${process.pid}-${Date.now()}.bin`);
        const content = Buffer.from('installeur factice WaCopilote');
        fs.writeFileSync(file, content);
        try {
            const result = await hashFile(file);
            expect(result.size).toBe(content.length);
            expect(result.sha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));
        } finally {
            fs.unlinkSync(file);
        }
    });
});
