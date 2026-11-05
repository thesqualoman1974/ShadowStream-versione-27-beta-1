namespace ShadowStream;

internal static class FfmpegLocator
{
    public static string FindOrThrow()
    {
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("SHADOWSTREAM_FFMPEG"),
            @"D:\ffmpeg\bin\ffmpeg.exe",
            Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe")
        };

        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return candidate;
            }
        }

        var fromPath = FindOnPath("ffmpeg.exe") ?? FindOnPath("ffmpeg");
        if (fromPath is not null)
        {
            return fromPath;
        }

        throw new FileNotFoundException(
            "FFmpeg non trovato. Installa FFmpeg oppure imposta SHADOWSTREAM_FFMPEG con il percorso di ffmpeg.exe.");
    }

    private static string? FindOnPath(string fileName)
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);

        foreach (var directory in paths)
        {
            try
            {
                var fullPath = Path.Combine(directory.Trim(), fileName);
                if (File.Exists(fullPath))
                {
                    return fullPath;
                }
            }
            catch (Exception)
            {
            }
        }

        return null;
    }

    public static bool SupportsFilter(string ffmpegPath, string filterName)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = ffmpegPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add("-hide_banner");
        startInfo.ArgumentList.Add("-filters");

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Impossibile interrogare le funzionalità di FFmpeg.");
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(5000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("Timeout durante la verifica dei filtri FFmpeg.");
        }

        Task.WaitAll(outputTask, errorTask);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Verifica dei filtri FFmpeg fallita (exit {process.ExitCode}): {errorTask.Result.Trim()}");
        }

        return outputTask.Result
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Any(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Contains(filterName, StringComparer.Ordinal));
    }
}
