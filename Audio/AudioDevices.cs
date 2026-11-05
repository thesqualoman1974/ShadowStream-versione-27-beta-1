namespace ShadowStream;

internal sealed record AudioDeviceOption(string Id, string Name);

internal sealed record AudioDeviceList(
    IReadOnlyList<AudioDeviceOption> Outputs,
    IReadOnlyList<AudioDeviceOption> Inputs,
    string? DefaultOutputId,
    string? DefaultInputId);

internal sealed record AudioDeviceSettings(
    string? OutputDeviceId,
    string? InputDeviceId,
    bool SystemAudioEnabled,
    bool MicrophoneEnabled);

internal static class AudioDeviceCatalog
{
    public static AudioDeviceList GetDevices()
    {
        using var enumerator = new MMDeviceEnumerator();
        var outputs = GetDevices(enumerator, DataFlow.Render);
        var inputs = GetDevices(enumerator, DataFlow.Capture);

        return new AudioDeviceList(
            outputs,
            inputs,
            GetDefaultDeviceId(enumerator, DataFlow.Render),
            GetDefaultDeviceId(enumerator, DataFlow.Capture));
    }

    private static IReadOnlyList<AudioDeviceOption> GetDevices(MMDeviceEnumerator enumerator, DataFlow flow)
    {
        var devices = enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
        var result = new List<AudioDeviceOption>(devices.Count);
        foreach (var device in devices)
        {
            result.Add(new AudioDeviceOption(device.ID, device.FriendlyName));
            device.Dispose();
        }

        return result;
    }

    private static string? GetDefaultDeviceId(MMDeviceEnumerator enumerator, DataFlow flow)
    {
        try
        {
            using var device = enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
            return device.ID;
        }
        catch (COMException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        catch (NAudio.MmException)
        {
            return null;
        }
    }
}
