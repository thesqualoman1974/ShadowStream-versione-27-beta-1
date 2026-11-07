async function start() {
    const config = require('./config');
    const { app, setDaemonStatusProvider } = require('./server');
    const { startBackgroundDaemon } = require('./background-daemon');
    const daemon = startBackgroundDaemon();
    setDaemonStatusProvider(daemon.getStatus);
    const server = app.listen(config.port, '127.0.0.1');

    try {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    } catch (error) {
        daemon.stop();
        throw error;
    }

    console.log(`=== Sentinel Core Security Backend Attivo [Porta ${config.port}] ===`);
    let shutdownPromise = null;
    function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        daemon.stop();
        shutdownPromise = new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        return shutdownPromise;
    }

    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    return { server, daemon, shutdown };
}

if (require.main === module) {
    start().catch(error => {
        console.error('Avvio del backend Sentinel Core non riuscito:', error);
        process.exitCode = 1;
    });
}

module.exports = { start };
