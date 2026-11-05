namespace ShadowStream;

internal sealed class FfmpegCaptureSession : IDisposable
{
    private readonly AppConfig _config;
    private readonly bool _supportsDdagrab;
    private readonly ConcurrentQueue<string> _stderrLines = new();
    private volatile Process? _process;
    private volatile AudioPipePump? _loopbackPump;
    private volatile AudioPipePump? _microphonePump;
    private CancellationTokenSource? _pumpCts;
    private Task? _stderrPump;
    private bool _continuousRecording;
    private bool _usingDirectXCapture;
    private string? _recordingOutputPath;

    public FfmpegCaptureSession(AppConfig config)
    {
        _config = config;
        _supportsDdagrab = !string.IsNullOrEmpty(config.FfmpegPath)
            && FfmpegLocator.SupportsFilter(config.FfmpegPath, "ddagrab");
    }

    public bool IsRunning => _process is { HasExited: false };

    public bool IsRecording => IsRunning && _continuousRecording;

    public string? RecordingOutputPath => _recordingOutputPath;

    public (int System, int Microphone, bool SystemCapturing, bool MicrophoneCapturing) AudioLevels =>
        (
            _loopbackPump?.LevelPercent ?? 0,
            _microphonePump?.LevelPercent ?? 0,
            IsRunning && _loopbackPump?.IsStarted == true,
            IsRunning && _microphonePump?.IsStarted == true
        );

    public void Start() => StartCore(allowAudio: true, continuousRecording: false, outputPath: null);

    public void StartRecording(string outputPath) =>
        StartCore(allowAudio: true, continuousRecording: true, outputPath);

    private void StartCore(bool allowAudio, bool continuousRecording, string? outputPath)
    {
        if (IsRunning)
        {
            throw new InvalidOperationException("La cattura è già attiva.");
        }

        if (_process is not null)
        {
            StopAsync().GetAwaiter().GetResult();
        }

        _continuousRecording = continuousRecording;
        _recordingOutputPath = outputPath;
        if (!continuousRecording)
        {
            PrepareBufferDirectory();
        }

        _stderrLines.Clear();

        _loopbackPump = allowAudio && _config.EnableSystemAudio
            ? TryCreateAudioPump(loopback: true, _config.AudioOutputDeviceId)
            : null;
        _microphonePump = allowAudio && _config.EnableMicrophone
            ? TryCreateAudioPump(loopback: false, _config.AudioInputDeviceId)
            : null;

        var startInfo = new ProcessStartInfo
        {
            FileName = _config.FfmpegPath,
            Arguments = BuildCaptureArguments(),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = false,
            RedirectStandardError = true,
            RedirectStandardInput = continuousRecording,
            StandardErrorEncoding = Encoding.UTF8
        };

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        if (!process.Start())
        {
            throw new InvalidOperationException("Impossibile avviare FFmpeg.");
        }

        _process = process;
        _pumpCts = new CancellationTokenSource();
        _stderrPump = PumpStderrAsync(process, _pumpCts.Token);

        try
        {
            _loopbackPump?.WaitForFfmpegAndStart(TimeSpan.FromSeconds(5), process);
            _microphonePump?.WaitForFfmpegAndStart(TimeSpan.FromSeconds(5), process);
        }
        catch (Exception ex)
        {
            if (process.HasExited)
            {
                StopAsync().GetAwaiter().GetResult();
                var stderr = ConsumeStderrTail();
                throw new InvalidOperationException(
                    string.IsNullOrWhiteSpace(stderr)
                        ? "FFmpeg è terminato durante l'avvio della cattura."
                        : $"FFmpeg è terminato durante l'avvio della cattura: {stderr}",
                    ex);
            }

            WriteWarn($"Audio non disponibile ({ex.Message}). Riavvio la cattura senza audio.");
            StopAsync().GetAwaiter().GetResult();
            StartCore(allowAudio: false, continuousRecording, outputPath);
            return;
        }

        if (process.WaitForExit(200))
        {
            StopAsync().GetAwaiter().GetResult();
            var stderr = ConsumeStderrTail();
            throw new InvalidOperationException(
                string.IsNullOrWhiteSpace(stderr)
                    ? "FFmpeg è terminato subito dopo l'avvio."
                    : $"FFmpeg è terminato subito dopo l'avvio: {stderr}");
        }
    }

    private AudioPipePump? TryCreateAudioPump(bool loopback, string? deviceId)
    {
        try
        {
            return new AudioPipePump(loopback, deviceId);
        }
        catch (COMException ex)
        {
            WriteWarn($"Dispositivo {(loopback ? "di uscita" : "microfono")} non disponibile: {ex.Message}");
            return null;
        }
        catch (InvalidOperationException ex)
        {
            WriteWarn($"Dispositivo {(loopback ? "di uscita" : "microfono")} non disponibile: {ex.Message}");
            return null;
        }
        catch (NotSupportedException ex)
        {
            WriteWarn($"Formato del dispositivo audio non supportato: {ex.Message}");
            return null;
        }
        catch (NAudio.MmException ex)
        {
            WriteWarn($"Errore WASAPI sul dispositivo {(loopback ? "di uscita" : "microfono")}: {ex.Message}");
            return null;
        }
    }

    public async Task StopAsync()
    {
        var process = _process;
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                if (_continuousRecording && process.StartInfo.RedirectStandardInput)
                {
                    try
                    {
                        await process.StandardInput.WriteLineAsync("q").ConfigureAwait(false);
                        await process.StandardInput.FlushAsync().ConfigureAwait(false);
                        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                        await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        WriteWarn("FFmpeg non ha finalizzato la registrazione in tempo; termino il processo.");
                    }
                    catch (IOException)
                    {
                    }
                }

                if (!process.HasExited)
                {
                    try
                    {
                        process.Kill(entireProcessTree: true);
                    }
                    catch (Exception)
                    {
                    }

                    process.WaitForExit(2000);
                }
            }
        }
        finally
        {
            if (_pumpCts is not null)
            {
                await _pumpCts.CancelAsync().ConfigureAwait(false);
            }

            try
            {
                if (_stderrPump is not null)
                {
                    await _stderrPump.ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
            }

            process.Dispose();
            _process = null;
            _pumpCts?.Dispose();
            _pumpCts = null;
            _stderrPump = null;
            _loopbackPump?.Dispose();
            _loopbackPump = null;
            _microphonePump?.Dispose();
            _microphonePump = null;
            _continuousRecording = false;
        }
    }

    public string ConsumeStderrTail(int maxLines = 12)
    {
        var lines = _stderrLines.ToArray();
        if (lines.Length == 0)
        {
            return string.Empty;
        }

        var start = Math.Max(0, lines.Length - maxLines);
        return string.Join(Environment.NewLine, lines[start..]);
    }

    public void Dispose()
    {
        StopAsync().GetAwaiter().GetResult();
    }

    private void PrepareBufferDirectory()
    {
        Directory.CreateDirectory(_config.BufferDirectory);
        foreach (var file in Directory.EnumerateFiles(_config.BufferDirectory, "seg_*.ts"))
        {
            try
            {
                File.Delete(file);
            }
            catch (IOException ex)
            {
                WriteWarn($"Impossibile rimuovere il vecchio segmento {Path.GetFileName(file)}: {ex.Message}");
            }
            catch (UnauthorizedAccessException ex)
            {
                WriteWarn($"Permesso negato eliminando il vecchio segmento {Path.GetFileName(file)}: {ex.Message}");
            }
        }
    }

    private string BuildVideoInputArgument()
    {
        var region = _config.Region;
        var fps = _config.FrameRate;
        _usingDirectXCapture = false;

        if (_config.CaptureMode == CaptureMode.Window && !string.IsNullOrWhiteSpace(_config.CaptureWindowTitle))
        {
            // Cattura finestra specifica: gdigrab title=
            // La risoluzione viene determinata automaticamente da gdigrab
            var escapedTitle = _config.CaptureWindowTitle!.Replace("\"", "\\\"");
            Console.ForegroundColor = ConsoleColor.Gray;
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Modalità cattura: Finestra → \"{escapedTitle}\"");
            Console.ResetColor();
            return $"-f gdigrab -framerate {fps} -draw_mouse 1 -i title=\"{escapedTitle}\"";
        }

        if (_supportsDdagrab && !region.NeedsNvencDownscale(_config.NvencMaxEdge))
        {
            _usingDirectXCapture = true;
            Console.ForegroundColor = ConsoleColor.Gray;
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Modalità cattura: Desktop Duplication DirectX (ddagrab) @ {fps} FPS");
            Console.ResetColor();
            return $"-f lavfi -i \"ddagrab=output_idx=0:framerate={fps}:draw_mouse=1\"";
        }

        if (!_supportsDdagrab)
        {
            WriteWarn("FFmpeg non include il filtro ddagrab; uso gdigrab (cattura CPU).");
        }
        else
        {
            WriteWarn("Risoluzione oltre il limite NVENC; uso gdigrab con ridimensionamento.");
        }

        // Cattura schermo intero: pixel logici (DPI-scaled) del monitor primario
        // gdigrab usa sempre coordinate logiche di Windows, non i pixel fisici
        Console.ForegroundColor = ConsoleColor.Gray;
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Modalità cattura: Schermo intero → {region.VideoSize} @ ({region.X},{region.Y})");
        Console.ResetColor();
        return $"-f gdigrab -framerate {fps} -draw_mouse 1 -offset_x {region.X} -offset_y {region.Y} -video_size {region.VideoSize} -i desktop";
    }

    private string BuildCaptureArguments()
    {
        var bitrate = $"{_config.VideoBitrateMbps}M";
        var bufsize = $"{Math.Max(1, _config.VideoBitrateMbps / 2)}M";
        var wrap = Math.Max(2, _config.BufferSeconds / Math.Max(1, _config.SegmentSeconds));
        var segmentPattern = FfmpegPath(_config.BufferDirectory, "seg_%03d.ts");
        var region = _config.Region;
        var videoInput = BuildVideoInputArgument();
        var scale = region.NeedsNvencDownscale(_config.NvencMaxEdge)
            ? $"-vf \"scale=w='min(iw,{_config.NvencMaxEdge})':h='min(ih,{_config.NvencMaxEdge})':force_original_aspect_ratio=decrease:force_divisible_by=2\""
            : string.Empty;
        var videoFilter = _usingDirectXCapture
            ? $"-vf \"setpts=N/({_config.FrameRate}*TB)\""
            : scale;

        var parts = new List<string>
        {
            "-y",
            "-hide_banner",
            "-loglevel warning",
            "-fflags nobuffer",
            "-flags low_delay",
            videoInput
        };
        if (!_continuousRecording)
        {
            parts.Insert(1, "-nostdin");
        }

        var hasLoopback = _loopbackPump is not null;
        var hasMicrophone = _microphonePump is not null;

        if (hasLoopback)
        {
            parts.Add(BuildAudioInput(_loopbackPump!));
        }

        if (hasMicrophone)
        {
            parts.Add(BuildAudioInput(_microphonePump!));
        }

        if (!string.IsNullOrEmpty(videoFilter))
        {
            parts.Add(videoFilter);
        }

        parts.AddRange(
        [
            "-c:v h264_nvenc",
            "-preset p1",
            "-tune ll",
            "-rc cbr",
            $"-b:v {bitrate}",
            $"-maxrate {bitrate}",
            $"-bufsize {bufsize}",
            "-profile:v high"
        ]);
        if (!_usingDirectXCapture)
        {
            parts.Add("-pix_fmt nv12");
        }

        parts.AddRange(
        [
            $"-g {_config.GopFrames}",
            "-bf 0",
            "-rc-lookahead 0",
            "-delay 0",
            $"-gpu {_config.GpuIndex}"
        ]);

        parts.Add(BuildAudioArguments(
            hasLoopback ? 1 : null,
            hasMicrophone ? (hasLoopback ? 2 : 1) : null));

        if (_continuousRecording)
        {
            parts.Add("-movflags +faststart");
            parts.Add($"\"{_recordingOutputPath}\"");
        }
        else
        {
            parts.AddRange(
            [
                "-f segment",
                $"-segment_time {_config.SegmentSeconds}",
                $"-segment_wrap {wrap}",
                "-segment_format mpegts",
                "-reset_timestamps 1",
                $"\"{segmentPattern}\""
            ]);
        }

        return string.Join(' ', parts);
    }

    /// <summary>
    /// Mappa l'audio: input 0 = video, gli input audio seguenti sono pipe WASAPI.
    /// Audio di sistema e microfono vengono mixati con amix.
    /// </summary>
    private static string BuildAudioInput(AudioPipePump pump) =>
        $"-use_wallclock_as_timestamps 1 -f {pump.SampleFormat} -ar {pump.Format.SampleRate} -ac {pump.Format.Channels} -i \"{pump.PipePath}\"";

    private string BuildAudioArguments(int? loopbackIndex, int? microphoneIndex)
    {
        var codec = $"-async 1 -ar 48000 -c:a aac -b:a {_config.AudioBitrateKbps}k -ac 2";
        const string stereoFormat =
            "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

        if (loopbackIndex is not null && microphoneIndex is not null)
        {
            return $"-filter_complex \"[{loopbackIndex}:a]{stereoFormat}[system];" +
                   $"[{microphoneIndex}:a]{stereoFormat}[microphone];" +
                   $"[system][microphone]amix=inputs=2:duration=first:dropout_transition=2:normalize=1[aout]\" " +
                   $"-map 0:v -map \"[aout]\" {codec}";
        }

        var audioIndex = loopbackIndex ?? microphoneIndex;
        if (audioIndex is not null)
        {
            return $"-map 0:v -map {audioIndex}:a -af \"{stereoFormat}\" {codec}";
        }

        return "-an";
    }

    private static void WriteWarn(string message)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");
        Console.ResetColor();
    }

    private static string FfmpegPath(params string[] parts)
    {
        var combined = parts.Length == 1 ? parts[0] : Path.Combine(parts);
        return Path.GetFullPath(combined).Replace('\\', '/');
    }

    private async Task PumpStderrAsync(Process process, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await process.StandardError.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                _stderrLines.Enqueue(line);
                while (_stderrLines.Count > 80 && _stderrLines.TryDequeue(out _))
                {
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
    }
}
