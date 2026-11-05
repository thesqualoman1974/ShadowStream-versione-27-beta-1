namespace ShadowStream;

internal sealed class AppOptions
{
    public bool StartBuffer { get; init; }
    public bool SaveClip { get; init; }
    public bool ForceHeadless { get; init; }
    public bool AutoStartBuffer { get; init; } = true;
    public bool KeepAlive { get; init; }
    public bool MeterOnly { get; init; }
    public int? BufferSeconds { get; init; }
    public CaptureMode CaptureMode { get; init; } = CaptureMode.Display;
    public string? CaptureWindowTitle { get; init; }
    public string? AudioOutputDeviceId { get; init; }
    public string? AudioInputDeviceId { get; init; }
    public bool EnableSystemAudio { get; init; } = true;
    public bool EnableMicrophone { get; init; } = true;
    public bool ListAudioDevices { get; init; }

    public static AppOptions Parse(string[] args)
    {
        var start = false;
        var save = false;
        var headless = false;
        var autoStartBuffer = true;
        var keepAlive = false;
        var meterOnly = false;
        int? bufferSeconds = null;
        var captureMode = CaptureMode.Display;
        string? captureWindowTitle = null;
        string? audioOutputDeviceId = null;
        string? audioInputDeviceId = null;
        var enableSystemAudio = true;
        var enableMicrophone = true;
        var listAudioDevices = false;

        for (var i = 0; i < args.Length; i++)
        {
            var raw = args[i].Trim();
            var lower = raw.ToLowerInvariant();

            if (lower.StartsWith("--buffer-seconds=", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(raw.Substring("--buffer-seconds=".Length), out var s) && s > 0)
                {
                    bufferSeconds = s;
                }
            }
            else if (lower == "--buffer-seconds" && i + 1 < args.Length)
            {
                if (int.TryParse(args[++i].Trim(), out var s) && s > 0)
                {
                    bufferSeconds = s;
                }
            }
            else if (lower.StartsWith("--buffer-minutes=", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(raw.Substring("--buffer-minutes=".Length), out var m) && m > 0)
                {
                    bufferSeconds = m * 60;
                }
            }
            else if (lower == "--buffer-minutes" && i + 1 < args.Length)
            {
                if (int.TryParse(args[++i].Trim(), out var m) && m > 0)
                {
                    bufferSeconds = m * 60;
                }
            }
            else
            {
                switch (lower)
                {
                    case "--start-buffer":
                    case "-r":
                        start = true;
                        break;
                    case "--save-clip":
                    case "-s":
                        save = true;
                        break;
                    case "--headless":
                        headless = true;
                        break;
                    case "--no-autostart":
                        autoStartBuffer = false;
                        break;
                    case "--keep-alive":
                        keepAlive = true;
                        break;
                    case "--meter-only":
                        meterOnly = true;
                        break;
                    case "--capture-window":
                        // il valore viene letto con la prossima iterazione
                        if (i + 1 < args.Length)
                        {
                            captureWindowTitle = args[++i].Trim();
                            captureMode = CaptureMode.Window;
                        }
                        break;
                    case "--capture-screen":
                        captureMode = CaptureMode.Display;
                        break;
                    case "--audio-output-id":
                        if (i + 1 < args.Length)
                        {
                            audioOutputDeviceId = args[++i].Trim();
                        }
                        break;
                    case "--audio-input-id":
                        if (i + 1 < args.Length)
                        {
                            audioInputDeviceId = args[++i].Trim();
                        }
                        break;
                    case "--no-system-audio":
                        enableSystemAudio = false;
                        break;
                    case "--no-microphone":
                        enableMicrophone = false;
                        break;
                    case "--list-audio-devices":
                        listAudioDevices = true;
                        break;
                    default:
                        break;
                }
            }
        }

        return new AppOptions
        {
            StartBuffer = start,
            SaveClip = save,
            ForceHeadless = headless,
            AutoStartBuffer = autoStartBuffer,
            KeepAlive = keepAlive,
            MeterOnly = meterOnly,
            BufferSeconds = bufferSeconds,
            CaptureMode = captureMode,
            CaptureWindowTitle = captureWindowTitle,
            AudioOutputDeviceId = audioOutputDeviceId,
            AudioInputDeviceId = audioInputDeviceId,
            EnableSystemAudio = enableSystemAudio,
            EnableMicrophone = enableMicrophone,
            ListAudioDevices = listAudioDevices
        };
    }
}

internal sealed class AppConfig
{
    public required string ClipsDirectory { get; init; }
    public required string BufferDirectory { get; init; }
    public required string FfmpegPath { get; init; }
    public int BufferSeconds { get; set; } = 300;
    public int FrameRate { get; init; } = 60;
    public int SegmentSeconds { get; init; } = 1;
    public int VideoBitrateMbps { get; init; } = 15;
    public int GopFrames { get; init; } = 60;
    public int GpuIndex { get; init; } = 0;
    public int NvencMaxEdge { get; init; } = 4096;
    public int AudioBitrateKbps { get; init; } = 192;
    public bool EnableSystemAudio { get; set; } = true;
    public bool EnableMicrophone { get; set; } = true;
    public string? AudioOutputDeviceId { get; set; }
    public string? AudioInputDeviceId { get; set; }
    public required CaptureRegion Region { get; init; }
    public CaptureMode CaptureMode { get; set; } = CaptureMode.Display;
    public string? CaptureWindowTitle { get; set; }

    public static AppConfig CreateDefault(AppOptions? options = null)
    {
        var clips = @"D:\ShadowStream\Clips";
        var buffer = @"D:\ShadowStream\Buffer";
        Directory.CreateDirectory(clips);
        Directory.CreateDirectory(buffer);

        var bufferSeconds = (options?.BufferSeconds is > 0) ? options.BufferSeconds.Value : 300;
        var captureMode = options?.CaptureMode ?? CaptureMode.Display;
        var captureWindowTitle = options?.CaptureWindowTitle;

        return new AppConfig
        {
            ClipsDirectory = clips,
            BufferDirectory = buffer,
            FfmpegPath = options?.MeterOnly == true ? string.Empty : FfmpegLocator.FindOrThrow(),
            BufferSeconds = bufferSeconds,
            AudioOutputDeviceId = options?.AudioOutputDeviceId,
            AudioInputDeviceId = options?.AudioInputDeviceId,
            EnableSystemAudio = options?.EnableSystemAudio ?? true,
            EnableMicrophone = options?.EnableMicrophone ?? true,
            Region = CaptureRegion.PrimaryMonitor(),
            CaptureMode = captureMode,
            CaptureWindowTitle = captureWindowTitle
        };
    }
}

/// <summary>
/// Area da catturare. h264_nvenc su molte GPU NVIDIA ha un limite di 4096 px;
/// un desktop virtuale multi-monitor (es. 5360 px) fa fallire l'encoder senza scrivere segmenti.
/// </summary>
internal readonly record struct CaptureRegion(int X, int Y, int Width, int Height)
{
    public string VideoSize => $"{Width}x{Height}";

    public bool NeedsNvencDownscale(int maxEdge) => Width > maxEdge || Height > maxEdge;

    public static CaptureRegion PrimaryMonitor()
    {
        var primary = NativeDisplay.GetPrimaryBounds();
        if (primary.Width >= 16 && primary.Height >= 16)
        {
            return primary;
        }

        return new CaptureRegion(0, 0, 1920, 1080);
    }
}
