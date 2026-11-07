function getUpdateErrorMessage(error) {
    const statusCode = Number(error?.statusCode ?? error?.response?.statusCode ?? error?.response?.status);

    if (statusCode === 404) {
        return 'Feed GitHub non disponibile (404). La prerelease potrebbe non essere pubblicata o il repository potrebbe non essere accessibile.';
    }
    if (error?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
        return 'Nessuna versione beta è ancora pubblicata su GitHub. Il controllo sarà disponibile dopo la pubblicazione della prerelease.';
    }
    if (statusCode === 401 || statusCode === 403) {
        return `GitHub ha rifiutato il controllo (${statusCode}). Verifica l’accesso al repository o riprova più tardi.`;
    }
    return 'Impossibile controllare gli aggiornamenti. Verifica la connessione e riprova.';
}

module.exports = { getUpdateErrorMessage };
