namespace ShadowStream;

internal sealed class ShadowStreamApp : IDisposable
{
    private readonly AppConfig _config;
    private readonly AppOptions _options;
    private readonly FfmpegCaptureSession _capture;
    private readonly ClipExporter _exporter;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _captureOperation = new(1, 1);
    private volatile AudioLevelMonitor? _systemAudioMonitor;
    private volatile AudioLevelMonitor? _microphoneMonitor;
    private int _saving;
    private bool _captureExitReported;
    private bool _captureShouldBeRunning;
    private bool _recording;
    private long _lastAudioLevelEmitTimestamp;

    public ShadowStreamApp(AppConfig config, AppOptions options)
    {
        _config = config;
        _options = options;
        _capture = new FfmpegCaptureSession(config);
        _exporter = new ClipExporter(config);
        Console.CancelKeyPress += OnCancelKeyPress;
    }

    public async Task<int> RunAsync()
    {
        PrintBanner();

        if (_options.ForceHeadless || !IsConsoleInteractive())
        {
            return await RunHeadlessAsync().ConfigureAwait(false);
        }

        if (_options.StartBuffer)
        {
            await StartBufferAsync().ConfigureAwait(false);
        }
        else
        {
            StartAudioMonitoring();
        }

        if (_options.SaveClip)
        {
            await SaveClipAsync().ConfigureAwait(false);
            if (!_options.KeepAlive)
            {
                await ShutdownAsync().ConfigureAwait(false);
                return 0;
            }
        }

        while (!_lifetime.IsCancellationRequested)
        {
            if (!TryReadKey(out var keyChar))
            {
                // La console è diventata non disponibile a runtime: prosegui in modalità headless.
                return await RunHeadlessAsync().ConfigureAwait(false);
            }

            if (keyChar is null)
            {
                await Task.Delay(40, _lifetime.Token).ConfigureAwait(false);
                MaybeReportCaptureDeath();
                EmitAudioLevels();
                continue;
            }

            switch (char.ToUpperInvariant(keyChar.Value))
            {
                case 'R':
                    await StartBufferAsync().ConfigureAwait(false);
                    break;
                case 'S':
                    await SaveClipAsync().ConfigureAwait(false);
                    break;
                case 'Q':
                    await ShutdownAsync().ConfigureAwait(false);
                    WriteInfo("Processi FFmpeg terminati. Uscita.");
                    return 0;
                default:
                    break;
            }
        }

        await ShutdownAsync().ConfigureAwait(false);
        return 0;
    }

    /// <summary>
    /// Modalità daemon: nessuna console interattiva (input rediretto o processo figlio senza TTY,
    /// es. avviato da Electron). Il buffer parte automaticamente e resta attivo fino alla terminazione.
    /// </summary>
    private async Task<int> RunHeadlessAsync()
    {
        WriteInfo(_options.AutoStartBuffer
            ? "Modalità headless: console non interattiva, avvio automatico del buffer. Ctrl+C per terminare."
            : "Modalità headless: console non interattiva, buffer in attesa di comando. Ctrl+C per terminare.");

        // Canale di controllo su stdin (R/P = buffer, T = registrazione, X = riavvio, S = clip, Q = esci).
        // Permette a una GUI esterna (Electron) di pilotare il daemon scrivendo sul pipe stdin del processo.
        _ = Task.Run(ReadControlCommandsAsync);

        if (_options.AutoStartBuffer)
        {
            await StartBufferAsync().ConfigureAwait(false);
            if (!_capture.IsRunning)
            {
                WriteWarn("Buffer non ancora attivo (possibile schermo bloccato o standby). In ascolto comandi o sblocco schermo...");
            }
        }
        else
        {
            StartAudioMonitoring();
            EmitCaptureStatus(false);
        }

        if (_options.SaveClip)
        {
            await SaveClipAsync().ConfigureAwait(false);
            if (!_options.KeepAlive)
            {
                await ShutdownAsync().ConfigureAwait(false);
                return 0;
            }
        }

        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                await Task.Delay(100, _lifetime.Token).ConfigureAwait(false);
                MaybeReportCaptureDeath();
                EmitAudioLevels();
            }
        }
        catch (OperationCanceledException)
        {
        }

        await ShutdownAsync().ConfigureAwait(false);
        return 0;
    }

    /// <summary>
    /// Legge comandi testuali da stdin per il pilotaggio esterno (es. GUI Electron).
    /// Una riga per comando: R/P controllano il buffer, T la registrazione, X riavvia, S salva la clip, Q esce.
    /// </summary>
    private static bool IsScreenLockedOrAccessDenied(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        return text.Contains("Failed to capture image (error 5)", StringComparison.OrdinalIgnoreCase)
            || text.Contains("error 5", StringComparison.OrdinalIgnoreCase)
            || text.Contains("Access is denied", StringComparison.OrdinalIgnoreCase);
    }

    private async Task ReadControlCommandsAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await Console.In.ReadLineAsync().ConfigureAwait(false);
            }
            catch (Exception)
            {
                return;
            }

            if (line is null)
            {
                return;
            }

            var parts = line.Trim().Split(new[] { ' ', '=' }, 2, StringSplitOptions.RemoveEmptyEntries);
            var cmd = parts.Length > 0 ? parts[0].ToUpperInvariant() : "";

            if (_options.MeterOnly && cmd is "R" or "P" or "STOP" or "T" or "RECORD"
                or "X" or "RESTART" or "S" or "B" or "BUFFER" or "MODE" or "M")
            {
                WriteWarn("Cattura e replay sono gestiti da OBS in questa modalità.");
                continue;
            }

            switch (cmd)
            {
                case "R":
                    await StartBufferAsync().ConfigureAwait(false);
                    break;
                case "P":
                case "STOP":
                    await StopBufferAsync().ConfigureAwait(false);
                    break;
                case "T":
                case "RECORD":
                    if (_recording)
                    {
                        await StopRecordingAsync().ConfigureAwait(false);
                    }
                    else
                    {
                        await StartRecordingAsync().ConfigureAwait(false);
                    }
                    break;
                case "X":
                case "RESTART":
                    await RestartCaptureAsync(startIfStopped: true).ConfigureAwait(false);
                    break;
                case "S":
                    await SaveClipAsync().ConfigureAwait(false);
                    break;
                case "Q":
                    _lifetime.Cancel();
                    return;
                case "B":
                case "BUFFER":
                    if (parts.Length > 1 && int.TryParse(parts[1], out var newSec) && newSec > 0)
                    {
                        _config.BufferSeconds = newSec;
                        WriteInfo($"Durata buffer impostata a {newSec}s ({(newSec / 60.0):0.#} min).");
                        if (_recording)
                        {
                            WriteInfo("La durata del buffer sarà applicata alla ripresa dell'Instant Replay.");
                        }
                        else
                        {
                            await RestartCaptureAsync().ConfigureAwait(false);
                        }
                    }
                    break;
                case "A":
                    if (parts.Length > 1)
                    {
                        await ApplyAudioSettingsAsync(parts[1]).ConfigureAwait(false);
                    }
                    break;
                case "MODE":
                case "M":
                    // M display | M window <titolo>
                    if (parts.Length > 1)
                    {
                        var modeArg = parts[1].Trim();
                        if (modeArg.StartsWith("window ", StringComparison.OrdinalIgnoreCase))
                        {
                            var title = modeArg.Substring("window ".Length).Trim();
                            var changed = _config.CaptureMode != CaptureMode.Window
                                || !string.Equals(_config.CaptureWindowTitle, title, StringComparison.Ordinal);
                            _config.CaptureMode = CaptureMode.Window;
                            _config.CaptureWindowTitle = title;
                            WriteInfo($"Modalità cattura cambiata: Finestra → \"{title}\"");
                            if (changed)
                            {
                                await RestartCaptureAsync().ConfigureAwait(false);
                            }
                        }
                        else if (modeArg.Equals("display", StringComparison.OrdinalIgnoreCase)
                              || modeArg.Equals("screen", StringComparison.OrdinalIgnoreCase))
                        {
                            var changed = _config.CaptureMode != CaptureMode.Display;
                            _config.CaptureMode = CaptureMode.Display;
                            _config.CaptureWindowTitle = null;
                            WriteInfo("Modalità cattura cambiata: Schermo intero");
                            if (changed)
                            {
                                await RestartCaptureAsync().ConfigureAwait(false);
                            }
                        }
                    }
                    break;
                case "AUDIODEVICES":
                    try
                    {
                        var devices = AudioDeviceCatalog.GetDevices();
                        var json = System.Text.Json.JsonSerializer.Serialize(
                            devices,
                            new System.Text.Json.JsonSerializerOptions
                            {
                                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
                            });
                        Console.WriteLine($"[AUDIO_DEVICES] {json}");
                    }
                    catch (COMException ex)
                    {
                        WriteError($"Impossibile elencare i dispositivi audio: {ex.Message}");
                    }
                    catch (InvalidOperationException ex)
                    {
                        WriteError($"Impossibile elencare i dispositivi audio: {ex.Message}");
                    }
                    catch (NAudio.MmException ex)
                    {
                        WriteError($"Impossibile elencare i dispositivi audio: {ex.Message}");
                    }
                    break;
                case "WINDOWS":
                case "W":
                    // Elenca le finestre visibili per la selezione dalla GUI
                    var windows = WindowEnumerator.GetVisibleWindows();
                    Console.WriteLine($"[WINDOWS] {System.Text.Json.JsonSerializer.Serialize(
                        windows,
                        new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))}");
                    break;
                default:
                    break;
            }
        }
    }

    private async Task ApplyAudioSettingsAsync(string encodedSettings)
    {
        AudioDeviceSettings? settings;
        try
        {
            var json = Encoding.UTF8.GetString(Convert.FromBase64String(encodedSettings));
            settings = System.Text.Json.JsonSerializer.Deserialize<AudioDeviceSettings>(
                json,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (FormatException ex)
        {
            WriteError($"Impostazioni audio non valide: {ex.Message}");
            return;
        }
        catch (System.Text.Json.JsonException ex)
        {
            WriteError($"Impostazioni audio non valide: {ex.Message}");
            return;
        }

        if (settings is null)
        {
            WriteError("Impostazioni audio non valide.");
            return;
        }

        var outputId = string.IsNullOrWhiteSpace(settings.OutputDeviceId) ? null : settings.OutputDeviceId;
        var inputId = string.IsNullOrWhiteSpace(settings.InputDeviceId) ? null : settings.InputDeviceId;
        var changed = _config.AudioOutputDeviceId != outputId
            || _config.AudioInputDeviceId != inputId
            || _config.EnableSystemAudio != settings.SystemAudioEnabled
            || _config.EnableMicrophone != settings.MicrophoneEnabled;

        _config.AudioOutputDeviceId = outputId;
        _config.AudioInputDeviceId = inputId;
        _config.EnableSystemAudio = settings.SystemAudioEnabled;
        _config.EnableMicrophone = settings.MicrophoneEnabled;

        if (changed)
        {
            WriteInfo("Impostazioni audio aggiornate.");
            await RestartCaptureAsync().ConfigureAwait(false);
        }
    }

    private async Task RestartCaptureAsync(bool startIfStopped = false)
    {
        await _captureOperation.WaitAsync(_lifetime.Token).ConfigureAwait(false);
        try
        {
            var wasActive = _capture.IsRunning || _recording;
            if (!wasActive && !startIfStopped)
            {
                StopAudioMonitoring();
                StartAudioMonitoring();
                return;
            }

            if (_recording)
            {
                await StopRecordingCoreAsync(restartBuffer: false).ConfigureAwait(false);
            }

            if (_capture.IsRunning)
            {
                _captureShouldBeRunning = false;
                await _capture.StopAsync().ConfigureAwait(false);
            }

            StartBufferCore();
        }
        finally
        {
            _captureOperation.Release();
        }
    }

    private async Task StartRecordingAsync()
    {
        await _captureOperation.WaitAsync(_lifetime.Token).ConfigureAwait(false);
        try
        {
            if (_recording)
            {
                return;
            }

            if (_capture.IsRunning)
            {
                _captureShouldBeRunning = false;
                await _capture.StopAsync().ConfigureAwait(false);
            }

            StopAudioMonitoring();
            Directory.CreateDirectory(_config.ClipsDirectory);
            var outputPath = Path.Combine(
                _config.ClipsDirectory,
                $"recording_{DateTime.Now:yyyyMMdd_HHmmss_fff}.mp4");
            _capture.StartRecording(outputPath);
            _recording = true;
            _captureExitReported = false;
            _captureShouldBeRunning = true;
            EmitRecordingStatus(true);
            EmitCaptureStatus(true);
            WriteOk($"Registrazione avviata: {outputPath}");
        }
        catch (Exception ex)
        {
            _recording = false;
            _captureShouldBeRunning = false;
            StartAudioMonitoring();
            EmitRecordingStatus(false);
            EmitCaptureStatus(false);
            WriteError($"Avvio registrazione fallito: {ex.Message}");
        }
        finally
        {
            _captureOperation.Release();
        }
    }

    private async Task StopRecordingAsync()
    {
        await _captureOperation.WaitAsync(_lifetime.Token).ConfigureAwait(false);
        try
        {
            await StopRecordingCoreAsync(restartBuffer: true).ConfigureAwait(false);
        }
        finally
        {
            _captureOperation.Release();
        }
    }

    private async Task StopRecordingCoreAsync(bool restartBuffer)
    {
        if (!_recording)
        {
            return;
        }

        _captureShouldBeRunning = false;
        await _capture.StopAsync().ConfigureAwait(false);
        _recording = false;
        EmitCaptureStatus(false);
        EmitRecordingStatus(false);

        var outputPath = _capture.RecordingOutputPath;
        if (!string.IsNullOrEmpty(outputPath) && File.Exists(outputPath) && new FileInfo(outputPath).Length > 0)
        {
            WriteOk($"Registrazione salvata: {outputPath}");
        }
        else
        {
            WriteWarn("Registrazione terminata senza un file MP4 valido.");
        }

        if (restartBuffer && !_lifetime.IsCancellationRequested)
        {
            StartBufferCore();
        }
        else if (!_lifetime.IsCancellationRequested)
        {
            StartAudioMonitoring();
        }
    }

    private async Task StopBufferAsync()
    {
        await _captureOperation.WaitAsync(_lifetime.Token).ConfigureAwait(false);
        try
        {
            if (_recording)
            {
                WriteWarn("Ferma prima la registrazione continua.");
                return;
            }

            await StopBufferCoreAsync().ConfigureAwait(false);
        }
        finally
        {
            _captureOperation.Release();
        }
    }

    private async Task StopBufferCoreAsync()
    {
        if (!_capture.IsRunning)
        {
            StartAudioMonitoring();
            EmitCaptureStatus(false);
            return;
        }

        _captureShouldBeRunning = false;
        await _capture.StopAsync().ConfigureAwait(false);
        StartAudioMonitoring();
        EmitCaptureStatus(false);
        WriteInfo("Buffer fermato.");
    }

    private static bool IsConsoleInteractive()
    {
        try
        {
            if (Console.IsInputRedirected)
            {
                return false;
            }

            _ = Console.KeyAvailable;
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    /// <summary>
    /// Legge un tasto senza mai propagare eccezioni quando la console non è disponibile.
    /// Restituisce false se la console non supporta la lettura, true altrimenti (keyChar null se nessun tasto).
    /// </summary>
    private static bool TryReadKey(out char? keyChar)
    {
        keyChar = null;
        try
        {
            if (!Console.KeyAvailable)
            {
                return true;
            }

            keyChar = Console.ReadKey(intercept: true).KeyChar;
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        Console.CancelKeyPress -= OnCancelKeyPress;
        StopAudioMonitoring();
        _lifetime.Dispose();
        _capture.Dispose();
    }

    private async Task StartBufferAsync()
    {
        await _captureOperation.WaitAsync(_lifetime.Token).ConfigureAwait(false);
        try
        {
            if (_recording)
            {
                WriteWarn("Ferma prima la registrazione continua.");
                return;
            }

            StartBufferCore();
        }
        finally
        {
            _captureOperation.Release();
        }
    }

    private void StartBufferCore()
    {
        if (_capture.IsRunning)
        {
            EmitCaptureStatus(true);
            return;
        }

        try
        {
            StopAudioMonitoring();
            _capture.Start();
            _captureExitReported = false;
            _captureShouldBeRunning = true;

            if (!_capture.IsRunning)
            {
                var stderr = _capture.ConsumeStderrTail();
                _captureShouldBeRunning = false;
                throw new InvalidOperationException(
                    string.IsNullOrWhiteSpace(stderr)
                        ? "FFmpeg è uscito subito dopo l'avvio (controlla che h264_nvenc sia disponibile)."
                        : stderr);
            }

            var region = _config.Region;
            WriteOk(
                $"Buffer avviato: monitor {region.VideoSize} @ ({region.X},{region.Y}), " +
                $"ultimi {_config.BufferSeconds}s @ {_config.FrameRate} FPS (h264_nvenc).");
            EmitCaptureStatus(true);

            if (region.NeedsNvencDownscale(_config.NvencMaxEdge))
            {
                WriteWarn($"Risoluzione sopra il limite NVENC H.264 ({_config.NvencMaxEdge}px): applico scale.");
            }
        }
        catch (OperationCanceledException)
        {
            StartAudioMonitoring();
            EmitCaptureStatus(false);
            return;
        }
        catch (Exception ex)
        {
            StartAudioMonitoring();
            EmitCaptureStatus(false);
            var stderr = _capture.ConsumeStderrTail();
            var combined = $"{ex.Message} {stderr}";
            if (IsScreenLockedOrAccessDenied(combined))
            {
                WriteWarn("Schermo bloccato o in standby (Windows Error 5 - Access Denied). La cattura rimarrà in pausa e riprenderà quando il display sarà sbloccato.");
            }
            else
            {
                WriteError($"Avvio FFmpeg fallito: {ex.Message}");
                if (!string.IsNullOrWhiteSpace(stderr))
                {
                    WriteError(stderr);
                }
            }
        }
    }

    private async Task SaveClipAsync()
    {
        if (_recording)
        {
            WriteWarn("Ferma la registrazione continua prima di salvare una clip del buffer.");
            return;
        }

        if (Interlocked.CompareExchange(ref _saving, 1, 0) != 0)
        {
            WriteWarn("Salvataggio già in corso.");
            return;
        }

        try
        {
            if (!_capture.IsRunning && !BufferSegmentLocator.HasAnyMedia(_config))
            {
                var stderr = _capture.ConsumeStderrTail();
                WriteWarn("Nessun buffer da salvare. Premi R per avviare la registrazione.");
                if (!string.IsNullOrWhiteSpace(stderr))
                {
                    WriteError(stderr);
                }

                return;
            }

            if (!BufferSegmentLocator.HasAnyMedia(_config))
            {
                WriteInfo("In attesa del primo segmento FFmpeg…");
                var deadline = DateTime.UtcNow.AddSeconds(3);
                while (!BufferSegmentLocator.HasAnyMedia(_config) && DateTime.UtcNow < deadline)
                {
                    await Task.Delay(150, _lifetime.Token).ConfigureAwait(false);
                }
            }

            var newest = BufferSegmentLocator.FindNewestMediaFile(_config);
            if (newest is not null)
            {
                WriteInfo($"Segmento più recente: {Path.GetFileName(newest)} → remux MP4…");
            }
            else
            {
                WriteWarn("Nessun segmento .ts disponibile nella cartella Buffer.");
            }

            var path = await _exporter.SaveLatestBufferAsync(_lifetime.Token).ConfigureAwait(false);
            WriteOk($"Clip salvata: {path}");
        }
        catch (Exception ex)
        {
            WriteError($"Salvataggio clip fallito: {ex.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _saving, 0);
        }
    }

    private async Task ShutdownAsync()
    {
        _lifetime.Cancel();
        _captureShouldBeRunning = false;
        StopAudioMonitoring();
        await _capture.StopAsync().ConfigureAwait(false);
        _recording = false;
        EmitCaptureStatus(false);
        EmitRecordingStatus(false);
    }

    private void MaybeReportCaptureDeath()
    {
        if (_captureExitReported || !_captureShouldBeRunning || _capture.IsRunning)
        {
            return;
        }

        _captureExitReported = true;
        _captureShouldBeRunning = false;
        _capture.StopAsync().GetAwaiter().GetResult();
        StartAudioMonitoring();
        if (_recording)
        {
            _recording = false;
            WriteError("La registrazione continua è stata interrotta da FFmpeg.");
        }
        EmitCaptureStatus(false);
        EmitRecordingStatus(false);
        var stderr = _capture.ConsumeStderrTail();
        if (IsScreenLockedOrAccessDenied(stderr))
        {
            WriteWarn("Cattura sospesa: schermo bloccato o display in standby (Windows Error 5). In attesa dello sblocco...");
            return;
        }

        if (string.IsNullOrWhiteSpace(stderr))
        {
            WriteWarn("Il processo FFmpeg si è chiuso. Premi R per riavviare il buffer.");
            return;
        }

        WriteError("FFmpeg si è chiuso:");
        WriteError(stderr);
    }

    private void EmitAudioLevels()
    {
        var now = Stopwatch.GetTimestamp();
        if (now - _lastAudioLevelEmitTimestamp < Stopwatch.Frequency / 10)
        {
            return;
        }

        _lastAudioLevelEmitTimestamp = now;
        var captureLevels = _capture.AudioLevels;
        var system = captureLevels.SystemCapturing
            ? captureLevels.System
            : _systemAudioMonitor?.LevelPercent ?? 0;
        var microphone = captureLevels.MicrophoneCapturing
            ? captureLevels.Microphone
            : _microphoneMonitor?.LevelPercent ?? 0;
        var systemCapturing = captureLevels.SystemCapturing || _systemAudioMonitor?.IsStarted == true;
        var microphoneCapturing = captureLevels.MicrophoneCapturing || _microphoneMonitor?.IsStarted == true;
        var json = System.Text.Json.JsonSerializer.Serialize(new
        {
            system,
            microphone,
            systemCapturing,
            microphoneCapturing
        });
        Console.WriteLine($"[AUDIO_LEVELS] {json}");
    }

    private void StartAudioMonitoring()
    {
        if (_capture.IsRunning || _lifetime.IsCancellationRequested)
        {
            return;
        }

        StopAudioMonitoring();
        if (_config.EnableSystemAudio)
        {
            _systemAudioMonitor = TryCreateAudioLevelMonitor(loopback: true, _config.AudioOutputDeviceId);
        }

        if (_config.EnableMicrophone)
        {
            _microphoneMonitor = TryCreateAudioLevelMonitor(loopback: false, _config.AudioInputDeviceId);
        }
    }

    private AudioLevelMonitor? TryCreateAudioLevelMonitor(bool loopback, string? deviceId)
    {
        AudioLevelMonitor? monitor = null;
        var source = loopback ? "audio del PC" : "microfono";
        try
        {
            monitor = new AudioLevelMonitor(loopback, deviceId);
            monitor.Start();
            return monitor;
        }
        catch (COMException ex)
        {
            WriteWarn($"Meter {source} non disponibile: {ex.Message}");
        }
        catch (InvalidOperationException ex)
        {
            WriteWarn($"Meter {source} non disponibile: {ex.Message}");
        }
        catch (NotSupportedException ex)
        {
            WriteWarn($"Formato del meter {source} non supportato: {ex.Message}");
        }
        catch (NAudio.MmException ex)
        {
            WriteWarn($"Errore WASAPI nel meter {source}: {ex.Message}");
        }

        monitor?.Dispose();
        return null;
    }

    private void StopAudioMonitoring()
    {
        var system = _systemAudioMonitor;
        _systemAudioMonitor = null;
        system?.Dispose();

        var microphone = _microphoneMonitor;
        _microphoneMonitor = null;
        microphone?.Dispose();
    }

    private void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true;
        _lifetime.Cancel();
    }

    private void PrintBanner()
    {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("ShadowStream");
        Console.ResetColor();
        if (_options.MeterOnly)
        {
            Console.WriteLine("Servizio di rilevamento audio per il motore OBS.");
            Console.WriteLine("Cattura, buffer e registrazioni sono gestiti da OBS Studio.");
            Console.WriteLine($"Monitor : {_config.Region.VideoSize} @ ({_config.Region.X},{_config.Region.Y})");
            Console.WriteLine($"Clip    : {_config.ClipsDirectory}");
            return;
        }

        Console.WriteLine("Replay buffer circolare ispirato a NVIDIA ShadowPlay.");
        Console.WriteLine($"FFmpeg : {_config.FfmpegPath}");
        Console.WriteLine($"Encoder: h264_nvenc @ {_config.FrameRate} FPS, GOP {_config.GopFrames}, {_config.VideoBitrateMbps} Mbps");
        Console.WriteLine($"Monitor: {_config.Region.VideoSize} @ ({_config.Region.X},{_config.Region.Y})");
        Console.WriteLine($"Buffer : {_config.BufferSeconds}s in {_config.BufferDirectory}");
        Console.WriteLine($"Clip   : {_config.ClipsDirectory}");
        Console.WriteLine();
        Console.WriteLine("  [R] Avvia il buffer circolare");
        Console.WriteLine("  [S] Salva gli ultimi secondi in .mp4");
        Console.WriteLine("  [Q] Ferma FFmpeg e esci");
        Console.WriteLine();
    }

    private static void WriteOk(string message) => WriteLine(ConsoleColor.Green, message);

    private static void WriteWarn(string message) => WriteLine(ConsoleColor.Yellow, message);

    private static void WriteError(string message) => WriteLine(ConsoleColor.Red, message);

    private static void WriteInfo(string message) => WriteLine(ConsoleColor.Gray, message);

    private static void WriteLine(ConsoleColor color, string message)
    {
        var stamp = DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
        Console.ForegroundColor = color;
        Console.WriteLine($"[{stamp}] {message}");
        Console.ResetColor();
    }

    private static void EmitCaptureStatus(bool running) =>
        Console.WriteLine($"[CAPTURE_STATUS] {running.ToString().ToLowerInvariant()}");

    private static void EmitRecordingStatus(bool recording) =>
        Console.WriteLine($"[RECORDING_STATUS] {recording.ToString().ToLowerInvariant()}");
}
