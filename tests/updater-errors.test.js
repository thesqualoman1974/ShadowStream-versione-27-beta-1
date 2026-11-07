const test = require('node:test');
const assert = require('node:assert/strict');
const { getUpdateErrorMessage } = require('../client/update-errors');

test('explains a missing GitHub release feed without exposing response details', () => {
    const error = Object.assign(new Error('raw response with cookie=secret'), { statusCode: 404 });
    const message = getUpdateErrorMessage(error);

    assert.match(message, /404/);
    assert.match(message, /prerelease/);
    assert.doesNotMatch(message, /cookie|secret|github\.com\/.*releases/i);
});

test('handles GitHub access failures without exposing the raw response', () => {
    const error = Object.assign(new Error('raw response with sensitive headers'), { response: { statusCode: 403 } });

    assert.equal(
        getUpdateErrorMessage(error),
        'GitHub ha rifiutato il controllo (403). Verifica l’accesso al repository o riprova più tardi.'
    );
});

test('explains that GitHub has no published beta release yet', () => {
    const error = Object.assign(new Error('raw updater details'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' });
    const message = getUpdateErrorMessage(error);

    assert.match(message, /Nessuna versione beta/i);
    assert.match(message, /pubblicata/i);
    assert.doesNotMatch(message, /raw updater details/i);
});

test('uses a generic safe message for network and unknown failures', () => {
    assert.equal(
        getUpdateErrorMessage(new Error('raw response with sensitive headers')),
        'Impossibile controllare gli aggiornamenti. Verifica la connessione e riprova.'
    );
});
