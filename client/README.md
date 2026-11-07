# Sentinel Core 27 beta 2

Avvia la dashboard con backend locale senza lasciare aperta la console di Node:

```powershell
npm --prefix client run dev
```

Il launcher e il backend registrano l’output in `%APPDATA%\ShadowStream\security\logs\launcher.log`. Per avviare con una console visibile a scopo diagnostico, usa `npm --prefix client run dev:console`.

Le risorse grafiche della suite sono in `assets/logo.png` e `assets/icon.ico` nella root del progetto. Il logo viene mostrato nell'interfaccia e l'icona nella finestra Electron.

Il comando avvia backend e finestra Electron insieme, senza packaging. Usa la cartella FiveM locale e il Windows Firewall reale. Se non è già elevato, chiede automaticamente i privilegi amministrativi tramite UAC; conferma la richiesta per applicare le regole. Il profilo/cache Electron è separato in `%APPDATA%\SentinelCore`, mentre token, ban e registro sono conservati in `%APPDATA%\ShadowStream\security`; i dati non vengono eliminati alla chiusura.

Per registrare in Discord i ban/sban manuali, avvia prima il bot locale con
`npm --prefix security install` e `npm --prefix security run bot:start` dalla
root. Bot e Sentinel Core devono essere eseguiti con lo stesso account Windows.
Il bot invia le azioni manuali di Sentinel Core solo a `ban-unban`.
`resoconto-player` resta riservato ai report di ShadowStream. Se il bot o il
canale operativo non è raggiungibile, Sentinel Core segnala che l'operazione
locale è riuscita ma la notifica è fallita.

## Creare l'app Windows separata

Installa le dipendenze del backend e del client, poi crea l'installer Sentinel Core:

```powershell
npm --prefix security install
npm --prefix client install
npm --prefix client run build:win
```

Il file generato è `sentinel-core-release\Sentinel-Core-Setup.exe`. È un installer separato da ShadowStream; l'app avvia il proprio backend locale e richiede i privilegi amministrativi per gestire Windows Firewall.

La dashboard mostra la versione installata e offre il controllo aggiornamenti. All'avvio l'app controlla automaticamente le release beta di `thesqualoman1974/Sentinel_core`; stato, errori e avanzamento del download vengono mostrati in un popup. **Riprova** avvia un nuovo controllo, mentre **Installa e riavvia** compare quando l'aggiornamento è pronto.

Per pubblicare una nuova release beta, il repository GitHub dedicato deve esistere e `GH_TOKEN` deve essere configurato nell'ambiente locale con permessi di pubblicazione:

```powershell
npm --prefix security install
$env:GH_TOKEN = 'TOKEN_CONFIGURATO_LOCALMENTE'
npm --prefix client run publish:win
Remove-Item Env:GH_TOKEN
```

Il comando pubblica la prerelease e gli artefatti di aggiornamento; non carica né modifica gli installer ShadowStream.

Il daemon esegue una scansione all’avvio e poi ogni 30 minuti. Per l’isolamento automatico dopo un rilevamento, configura `SHADOWSTREAM_SCAN_STEAM_HEX` e `SHADOWSTREAM_SCAN_SERVER_IP` nell’ambiente prima di avviare il client; senza questi valori, le anomalie vengono registrate ma non viene applicata una regola automatica.

Non serve copiare o inserire token: il backend ne genera uno all’avvio e la dashboard lo recupera localmente per autorizzare ban, sblocchi e ricerca. La lista ban si carica automaticamente. Inserisci nome Steam, Steam Hex, IP e motivazione, poi premi **Applica ban**; seleziona un risultato per compilare il modulo prima di **Rimuovi ban selezionato**. Il blocco locale interessa l’IP inserito e non applica un ban sull’account nel server FiveM. Chiudi la finestra Electron per arrestare il backend.

`npm start` nel client avvia soltanto Electron e richiede un backend avviato separatamente. Il token viene generato all’avvio del backend e resta nei dati locali dell’applicazione; non deve essere copiato nella dashboard.
