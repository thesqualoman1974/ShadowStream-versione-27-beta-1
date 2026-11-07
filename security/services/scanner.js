const { readdirSync, existsSync } = require('fs');

const SIGNATURES = Object.freeze(['.asi', 'cheat', 'modmenu']);

function scan(gameDir) {
    if (!existsSync(gameDir)) return null;

    for (const entry of readdirSync(gameDir, { withFileTypes: true })) {
        const name = entry.name.toLowerCase();
        if (SIGNATURES.some(signature => name.endsWith(signature) || name.includes(signature))) {
            return { name: entry.name, kind: entry.isDirectory() ? 'cartella' : 'file' };
        }
    }

    return null;
}

module.exports = { scan };
