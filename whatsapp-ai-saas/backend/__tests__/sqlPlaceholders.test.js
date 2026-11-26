// Garde-fou (D1, docs/audit.md) : la couche de compatibilité de db.js
// remplace chaque marqueur $n par un « ? » positionnel. Un même marqueur
// utilisé deux fois dans une requête décale donc toutes les valeurs suivantes
// — PostgreSQL l'accepte, SQLite non. Ce test analyse les requêtes du backend
// et du CLI et échoue si l'une d'elles réutilise un marqueur.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const appRoot = path.resolve(__dirname, '..', '..');

function sourceFiles() {
    const files = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.c?js$/.test(entry.name)) files.push(full);
        }
    })(path.join(appRoot, 'backend'));
    files.push(path.join(appRoot, 'bin', 'wacopilote.cjs'));
    return files;
}

// Les commentaires sont retirés avant l'analyse : leurs apostrophes
// (« l'agent », « d'API ») feraient prendre du texte pour des chaînes.
function withoutCommentLines(source) {
    return source.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
        const inline = line.indexOf(' // ');
        return inline >= 0 ? line.slice(0, inline) : line;
    }).join('\n');
}

const STRING_LITERAL = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
const PLACEHOLDER = /\$\d+/g;

function findReusedPlaceholders() {
    const problems = [];
    let analysed = 0;
    for (const file of sourceFiles()) {
        const source = withoutCommentLines(fs.readFileSync(file, 'utf8'));
        for (const match of source.matchAll(STRING_LITERAL)) {
            const literal = match[0];
            const markers = literal.match(PLACEHOLDER);
            if (!markers || !SQL_KEYWORD.test(literal)) continue;
            analysed++;
            const counts = {};
            for (const marker of markers) counts[marker] = (counts[marker] || 0) + 1;
            const reused = Object.keys(counts).filter((marker) => counts[marker] > 1);
            if (reused.length) {
                const line = source.slice(0, match.index).split('\n').length;
                problems.push(`${path.relative(appRoot, file)}:${line} réutilise ${reused.join(', ')}`);
            }
        }
    }
    return { problems, analysed };
}

describe('requêtes SQL — marqueurs $n', () => {
    it('aucune requête ne réutilise un marqueur', () => {
        const { problems, analysed } = findReusedPlaceholders();
        // Sanité : l'analyse trouve bien les requêtes (plus de 70 aujourd'hui).
        expect(analysed).toBeGreaterThan(50);
        expect(problems).toEqual([]);
    });
});
