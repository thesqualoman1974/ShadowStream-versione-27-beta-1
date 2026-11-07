const fs = require('fs');
const path = require('path');

function getStaffToken({
    environment = process.env,
    dataDir = environment.SHADOWSTREAM_DATA_DIR || path.join(__dirname, '..', 'security')
} = {}) {
    const configuredToken = environment.SHADOWSTREAM_STAFF_TOKEN;
    if (configuredToken && configuredToken.length >= 32) return configuredToken;

    const tokenFile = path.join(dataDir, 'logs', 'staff-token.log');
    let savedToken;
    try {
        savedToken = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }

    const match = /^\[[^\]]+\] ([A-Za-z0-9_-]{43})$/.exec(savedToken);
    if (!match) {
        throw new Error(`Token staff non valido in ${tokenFile}.`);
    }
    return match[1];
}

module.exports = { getStaffToken };
