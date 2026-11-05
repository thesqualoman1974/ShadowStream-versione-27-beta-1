namespace ShadowStream;

internal sealed class AudioPipePump : IDisposable
{
    private static readonly TimeSpan IdleSilenceInterval = TimeSpan.FromMilliseconds(50);

    private readonly MMDeviceEnumerator _enumerator;
    private readonly MMDevice _device;
    private readonly IWaveIn _capture;
    private readonly NamedPipeServerStream _pipe;
    private readonly Channel<byte[]> _queue;
    private readonly CancellationTokenSource _cts = new();
    private readonly byte[] _silence;
    private Task? _writer;
    private volatile bool _started;

    public AudioPipePump(bool loopback, string? deviceId)
    {
        _enumerator = new MMDeviceEnumerator();
        var flow = loopback ? DataFlow.Render : DataFlow.Capture;
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            _device = _enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
        }
        else
        {
            try
            {
                _device = _enumerator.GetDevice(deviceId);
            }
            catch (COMException)
            {
                WriteWarn($"Dispositivo {(loopback ? "di uscita" : "microfono")} salvato non disponibile; uso il predefinito.");
                _device = _enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
            }
        }
        _capture = loopback
            ? new WasapiLoopbackCapture(_device)
            : new WasapiCapture(_device);
        PipeName = $"ShadowStreamAudio_{Environment.ProcessId}_{Guid.NewGuid():N}";
        _pipe = new NamedPipeServerStream(
            PipeName,
            PipeDirection.Out,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 64 * 1024);
        _queue = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(48)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.DropOldest
        });
        Format = _capture.WaveFormat;
        SampleFormat = GetSampleFormat(Format);

        var frames = Math.Max(1, (int)(Format.SampleRate * IdleSilenceInterval.TotalSeconds));
        _silence = new byte[Math.Max(1, Format.BlockAlign) * frames];
        _capture.DataAvailable += OnDataAvailable;
    }

    public string PipeName { get; }
    public string PipePath => @"\\.\pipe\" + PipeName;
    public WaveFormat Format { get; }
    public string SampleFormat { get; }
    public bool IsStarted => _started;
    public int LevelPercent => Volatile.Read(ref _levelPercent);

    private int _levelPercent;

    private static void WriteWarn(string message)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");
        Console.ResetColor();
    }

    public void WaitForFfmpegAndStart(TimeSpan timeout, Process ffmpegProcess)
    {
        var connected = _pipe.WaitForConnectionAsync(_cts.Token);
        var timer = Stopwatch.StartNew();
        while (!connected.IsCompleted && timer.Elapsed < timeout)
        {
            if (ffmpegProcess.HasExited)
            {
                throw new InvalidOperationException("FFmpeg è terminato prima di collegarsi alla pipe audio.");
            }

            connected.Wait(TimeSpan.FromMilliseconds(50));
        }

        if (!connected.IsCompleted)
        {
            throw new TimeoutException("FFmpeg non si è collegato alla pipe audio entro il tempo previsto.");
        }

        connected.GetAwaiter().GetResult();
        _writer = Task.Run(() => WriteLoopAsync(_cts.Token));
        _capture.StartRecording();
        _started = true;
    }

    public void Dispose()
    {
        _capture.DataAvailable -= OnDataAvailable;
        try
        {
            if (_started)
            {
                _capture.StopRecording();
            }
        }
        catch (InvalidOperationException)
        {
        }
        catch (NAudio.MmException)
        {
        }

        _queue.Writer.TryComplete();
        _cts.Cancel();
        try
        {
            _writer?.Wait(1000);
        }
        catch (AggregateException)
        {
        }

        _capture.Dispose();
        _pipe.Dispose();
        _device.Dispose();
        _enumerator.Dispose();
        _cts.Dispose();
    }

    private static string GetSampleFormat(WaveFormat format)
    {
        if (format is WaveFormatExtensible extensible)
        {
            if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT)
            {
                return format.BitsPerSample == 64 ? "f64le" : "f32le";
            }

            if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_PCM)
            {
                return format.BitsPerSample switch
                {
                    8 => "u8",
                    16 => "s16le",
                    24 => "s24le",
                    32 => "s32le",
                    _ => throw new NotSupportedException(
                        $"Formato PCM WASAPI non supportato: {format.BitsPerSample} bit.")
                };
            }
        }

        if (format.Encoding == WaveFormatEncoding.IeeeFloat)
        {
            return format.BitsPerSample == 64 ? "f64le" : "f32le";
        }

        return format.BitsPerSample switch
        {
            8 => "u8",
            16 => "s16le",
            24 => "s24le",
            32 => "s32le",
            _ => throw new NotSupportedException(
                $"Formato audio WASAPI non supportato: {format.Encoding}, {format.BitsPerSample} bit.")
        };
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded <= 0)
        {
            return;
        }

        Volatile.Write(ref _levelPercent, MeasureLevelPercent(e.Buffer, e.BytesRecorded, Format));
        var copy = new byte[e.BytesRecorded];
        Buffer.BlockCopy(e.Buffer, 0, copy, 0, e.BytesRecorded);
        _queue.Writer.TryWrite(copy);
    }

    internal static int MeasureLevelPercent(byte[] buffer, int bytesRecorded, WaveFormat format)
    {
        var isFloat = format.Encoding == WaveFormatEncoding.IeeeFloat;
        if (format is WaveFormatExtensible extensible)
        {
            isFloat = extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT;
        }

        var bytesPerSample = format.BitsPerSample / 8;
        if (bytesPerSample is not (1 or 2 or 3 or 4 or 8))
        {
            return 0;
        }

        var sampleCount = bytesRecorded / bytesPerSample;
        if (sampleCount == 0)
        {
            return 0;
        }

        double peak = 0;
        for (var i = 0; i < sampleCount; i++)
        {
            var offset = i * bytesPerSample;
            double sample;
            if (isFloat)
            {
                sample = bytesPerSample switch
                {
                    4 => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(buffer.AsSpan(offset, 4))),
                    8 => BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(offset, 8))),
                    _ => 0
                };
            }
            else
            {
                sample = bytesPerSample switch
                {
                    1 => (buffer[offset] - 128) / 128.0,
                    2 => BinaryPrimitives.ReadInt16LittleEndian(buffer.AsSpan(offset, 2)) / 32768.0,
                    3 => ReadInt24(buffer, offset) / 8388608.0,
                    4 => BinaryPrimitives.ReadInt32LittleEndian(buffer.AsSpan(offset, 4)) / 2147483648.0,
                    _ => 0
                };
            }

            if (double.IsFinite(sample))
            {
                peak = Math.Max(peak, Math.Abs(sample));
            }
        }

        if (peak < 0.001)
        {
            return 0;
        }

        var decibels = 20 * Math.Log10(Math.Min(1, peak));
        return Math.Clamp((int)Math.Round((decibels + 60) * (100.0 / 60)), 0, 100);
    }

    private static int ReadInt24(byte[] buffer, int offset)
    {
        var value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        return (value & 0x800000) == 0 ? value : value | unchecked((int)0xFF000000);
    }

    private async Task WriteLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                if (_queue.Reader.TryRead(out var chunk))
                {
                    await _pipe.WriteAsync(chunk, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                var waitToRead = _queue.Reader.WaitToReadAsync(cancellationToken).AsTask();
                var delay = Task.Delay(IdleSilenceInterval, cancellationToken);
                var completed = await Task.WhenAny(waitToRead, delay).ConfigureAwait(false);

                if (completed == waitToRead)
                {
                    if (!await waitToRead.ConfigureAwait(false))
                    {
                        break;
                    }

                    continue;
                }

                await _pipe.WriteAsync(_silence, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }
}

internal sealed class AudioLevelMonitor : IDisposable
{
    private readonly MMDeviceEnumerator _enumerator;
    private readonly MMDevice _device;
    private readonly IWaveIn _capture;
    private volatile bool _started;
    private int _levelPercent;

    public AudioLevelMonitor(bool loopback, string? deviceId)
    {
        _enumerator = new MMDeviceEnumerator();
        var flow = loopback ? DataFlow.Render : DataFlow.Capture;
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            _device = _enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
        }
        else
        {
            try
            {
                _device = _enumerator.GetDevice(deviceId);
            }
            catch (COMException)
            {
                _device = _enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
            }
        }

        _capture = loopback
            ? new WasapiLoopbackCapture(_device)
            : new WasapiCapture(_device);
        _capture.DataAvailable += OnDataAvailable;
    }

    public bool IsStarted => _started;
    public int LevelPercent => Volatile.Read(ref _levelPercent);

    public void Start()
    {
        _capture.StartRecording();
        _started = true;
    }

    public void Dispose()
    {
        _capture.DataAvailable -= OnDataAvailable;
        if (_started)
        {
            try
            {
                _capture.StopRecording();
            }
            catch (InvalidOperationException)
            {
            }
            catch (NAudio.MmException)
            {
            }
        }

        _started = false;
        _capture.Dispose();
        _device.Dispose();
        _enumerator.Dispose();
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded > 0)
        {
            Volatile.Write(
                ref _levelPercent,
                AudioPipePump.MeasureLevelPercent(e.Buffer, e.BytesRecorded, _capture.WaveFormat));
        }
    }
}

/// <summary>
/// Trova i segmenti .ts prodotti dinamicamente da FFmpeg (nomi rotanti in buffer circolare).
/// Non dipende da un file fisso tipo buffer_000.mp4.
/// </summary>
