namespace ShadowStream;

internal static class BufferSegmentLocator
{
    private static readonly string[] MediaExtensions = [".ts", ".mp4", ".m4s", ".m4v"];

    /// <summary>
    /// Margine di sicurezza oltre la durata del segmento: i file modificati più di recente
    /// sono ancora in fase di scrittura da parte di FFmpeg e non vanno concatenati.
    /// </summary>
    private static readonly TimeSpan ActiveWriteMargin = TimeSpan.FromMilliseconds(500);

    public static IReadOnlyList<string> FindRecentSegments(AppConfig config)
    {
        if (!Directory.Exists(config.BufferDirectory))
        {
            return [];
        }

        var now = DateTime.UtcNow;
        var cutoff = now.AddSeconds(-(config.BufferSeconds + config.SegmentSeconds + 2));
        var activeCutoff = now - TimeSpan.FromSeconds(config.SegmentSeconds) - ActiveWriteMargin;

        return Directory.EnumerateFiles(config.BufferDirectory, "seg_*.ts")
            .Where(path => MediaExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
            .Select(path => new FileInfo(path))
            .Where(info => info.Exists && info.Length > 0)
            .Where(info => info.LastWriteTimeUtc >= cutoff && info.LastWriteTimeUtc <= activeCutoff)
            .OrderBy(info => info.LastWriteTimeUtc)
            .ThenBy(info => info.Name, StringComparer.OrdinalIgnoreCase)
            .Select(info => info.FullName)
            .ToArray();
    }

    public static string? FindNewestMediaFile(AppConfig config)
    {
        if (!Directory.Exists(config.BufferDirectory))
        {
            return null;
        }

        return Directory.EnumerateFiles(config.BufferDirectory)
            .Where(path => MediaExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
            .Where(path => !Path.GetFileName(path).StartsWith("recording_", StringComparison.OrdinalIgnoreCase)
                && !Path.GetFileName(path).StartsWith("clip_", StringComparison.OrdinalIgnoreCase))
            .Select(path => new FileInfo(path))
            .Where(info => info.Exists && info.Length > 0)
            .OrderByDescending(info => info.LastWriteTimeUtc)
            .ThenByDescending(info => info.Name, StringComparer.OrdinalIgnoreCase)
            .Select(info => info.FullName)
            .FirstOrDefault();
    }

    public static bool HasAnyMedia(AppConfig config) => FindNewestMediaFile(config) is not null;
}

/// <summary>
/// Processo FFmpeg in background: cattura desktop DirectX a 60 FPS (ddagrab), encode NVENC,
/// segmenti .ts in buffer circolare e audio di gioco (loopback WASAPI via named pipe) + microfono opzionale.
/// </summary>
