namespace ShadowStream;

internal sealed class ClipExporter
{
    private readonly AppConfig _config;

    public ClipExporter(AppConfig config)
    {
        _config = config;
    }

    public async Task<string> SaveLatestBufferAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_config.ClipsDirectory);

        var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
        var outputPath = Path.Combine(_config.ClipsDirectory, $"clip_{stamp}.mp4");

        var segments = BufferSegmentLocator.FindRecentSegments(_config);
        if (segments.Count == 0)
        {
            var newest = BufferSegmentLocator.FindNewestMediaFile(_config);
            if (newest is null)
            {
                throw new InvalidOperationException(
                    "Nessun segmento .ts/.mp4 trovato nella cartella Buffer. Attendi almeno 1 secondo di cattura.");
            }

            segments = [newest];
        }

        try
        {
            if (segments.Count == 1)
            {
                await RemuxAsync(segments[0], outputPath, cancellationToken).ConfigureAwait(false);
                return outputPath;
            }

            await ConcatRemuxAsync(segments, outputPath, cancellationToken).ConfigureAwait(false);
            return outputPath;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception first)
        {
            var newest = BufferSegmentLocator.FindNewestMediaFile(_config)
                ?? throw new InvalidOperationException(
                    $"Muxing del buffer fallito e nessun segmento recente disponibile. {first.Message}");

            WriteFallback(newest, first.Message);
            await RemuxAsync(newest, outputPath, cancellationToken).ConfigureAwait(false);
            return outputPath;
        }
    }

    private async Task ConcatRemuxAsync(
        IReadOnlyList<string> segments,
        string outputPath,
        CancellationToken cancellationToken)
    {
        var listPath = Path.Combine(Path.GetTempPath(), $"shadowstream_concat_{Guid.NewGuid():N}.txt");
        try
        {
            var list = new StringBuilder();
            foreach (var segment in segments)
            {
                var escaped = segment.Replace('\\', '/').Replace("'", @"'\''");
                list.Append("file '").Append(escaped).Append('\'').AppendLine();
            }

            await File.WriteAllTextAsync(listPath, list.ToString(), cancellationToken).ConfigureAwait(false);
            var args =
                $"-hide_banner -loglevel error -y -fflags +genpts+discardcorrupt " +
                $"-f concat -safe 0 -i \"{listPath}\" -c copy -movflags +faststart \"{outputPath}\"";
            await RunFfmpegAsync(args, outputPath, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            TryDelete(listPath);
        }
    }

    private Task RemuxAsync(string inputPath, string outputPath, CancellationToken cancellationToken)
    {
        var args =
            $"-hide_banner -loglevel error -y -fflags +genpts+discardcorrupt " +
            $"-i \"{inputPath}\" -c copy -movflags +faststart \"{outputPath}\"";
        return RunFfmpegAsync(args, outputPath, cancellationToken);
    }

    private async Task RunFfmpegAsync(string arguments, string outputPath, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _config.FfmpegPath,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = false
        };

        using var remux = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Impossibile avviare FFmpeg per il remux della clip.");

        var stderr = await remux.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        await remux.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

        if (remux.ExitCode != 0 || !File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
        {
            throw new InvalidOperationException(
                string.IsNullOrWhiteSpace(stderr)
                    ? $"Remux FFmpeg non riuscito (exit {remux.ExitCode})."
                    : stderr.Trim());
        }
    }

    private static void WriteFallback(string newest, string reason)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine(
            $"[{DateTime.Now:HH:mm:ss}] Concat non riuscito ({reason.Trim()}). Uso il segmento più recente: {Path.GetFileName(newest)}");
        Console.ResetColor();
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception)
        {
        }
    }
}
