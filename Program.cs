namespace ShadowStream;

internal enum CaptureMode
{
    Display,  // Cattura desktop intero (ddagrab, con fallback gdigrab)
    Window    // Cattura finestra specifica per titolo (gdigrab title=...)
}

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "ShadowStream";

        try
        {
            var options = AppOptions.Parse(args);
            if (options.ListAudioDevices)
            {
                var devices = AudioDeviceCatalog.GetDevices();
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                    devices,
                    new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
                    }));
                return 0;
            }

            using var app = new ShadowStreamApp(AppConfig.CreateDefault(options), options);
            return await app.RunAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Errore fatale: {ex.Message}");
            Console.ResetColor();
            return 1;
        }
    }
}

/// <summary>
/// Opzioni da riga di comando per il pilotaggio headless (es. da una GUI Electron via CLI/IPC).
/// </summary>
