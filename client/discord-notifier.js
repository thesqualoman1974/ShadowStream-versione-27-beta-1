'use strict';

const DEFAULT_BOT_URL = 'http://127.0.0.1:3001';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function getLocalBotUrl(value = process.env.SHADOWSTREAM_DISCORD_BOT_URL || DEFAULT_BOT_URL) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('URL del bot Discord non valida.');
    }

    if (url.protocol !== 'http:'
        || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
        || url.username
        || url.password
        || url.pathname !== '/'
        || url.search
        || url.hash) {
        throw new Error('Il collegamento Discord è consentito solo al bot locale (localhost).');
    }

    return url.origin;
}

async function notifyDiscordEvent(event, {
    token,
    botUrl,
    fetchImpl = fetch,
    timeoutMs = 5_000
} = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        return { success: false, error: 'Token locale Sentinel Core non disponibile.' };
    }

    let endpoint;
    try {
        endpoint = `${getLocalBotUrl(botUrl)}/api/shadowstream/events`;
    } catch (error) {
        return { success: false, error: error.message };
    }

    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(timeoutMs)
        });
        let result;
        try {
            result = await response.json();
        } catch {
            return { success: false, error: 'Il bot Discord ha restituito una risposta non valida.' };
        }
        if (!response.ok || result?.success !== true) {
            return {
                success: false,
                error: result?.error || 'Il bot Discord non ha confermato entrambe le notifiche.',
                sent: Array.isArray(result?.sent) ? result.sent : [],
                failed: Array.isArray(result?.failed) ? result.failed : []
            };
        }
        return { success: true, sent: result.sent };
    } catch (error) {
        return {
            success: false,
            error: error.name === 'TimeoutError'
                ? 'Timeout nel contatto con il bot Discord locale.'
                : `Bot Discord locale non raggiungibile: ${error.message}`
        };
    }
}

module.exports = { DEFAULT_BOT_URL, getLocalBotUrl, notifyDiscordEvent };
