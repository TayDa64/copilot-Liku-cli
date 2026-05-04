using System.Text.Json;

namespace AutomationHost.Rpc;

internal sealed class JsonRpcRequestMessage
{
    public string Jsonrpc { get; set; } = "2.0";
    public JsonElement? Id { get; set; }
    public string Method { get; set; } = string.Empty;
    public JsonElement? Params { get; set; }
}

internal sealed class JsonRpcError
{
    public int Code { get; set; }
    public string Message { get; set; } = string.Empty;
}

internal sealed class WindowInfoResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
    public long Hwnd { get; set; }
    public int Pid { get; set; }
    public string ProcessName { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public long OwnerHwnd { get; set; }
    public bool IsTopmost { get; set; }
    public bool IsToolWindow { get; set; }
    public bool IsMinimized { get; set; }
    public bool IsMaximized { get; set; }
    public string WindowKind { get; set; } = string.Empty;
}

internal sealed class PingRequest
{
    public string? Message { get; set; }
}

internal sealed class PingResponse
{
    public string Message { get; set; } = "pong";
    public string ProtocolVersion { get; set; } = "2.0";
    public string HostVersion { get; set; } = "0.1.0-phase0";
    public string InstanceId { get; set; } = string.Empty;
    public int ProcessId { get; set; }
    public DateTimeOffset TimestampUtc { get; set; }
}

internal sealed class ShutdownRequest
{
    public string? Reason { get; set; }
}

internal sealed class ShutdownResponse
{
    public bool Acknowledged { get; set; }
    public string Reason { get; set; } = "client-request";
    public DateTimeOffset TimestampUtc { get; set; }
}

internal sealed class InvokeRequest
{
    public string Method { get; set; } = string.Empty;
    public JsonElement? Params { get; set; }
}

internal sealed class InvokeResponse
{
    public bool Success { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public object? Result { get; set; }
}

internal sealed class InvokeBatchRequest
{
    public IReadOnlyList<InvokeRequest> Invocations { get; set; } = Array.Empty<InvokeRequest>();
}

internal sealed class InvokeBatchResponse
{
    public int Count { get; set; }
    public IReadOnlyList<InvokeResponse> Results { get; set; } = Array.Empty<InvokeResponse>();
}

internal sealed class HostLifecycleNotification
{
    public string State { get; set; } = string.Empty;
    public string InstanceId { get; set; } = string.Empty;
    public int ProcessId { get; set; }
    public DateTimeOffset TimestampUtc { get; set; }
    public string? Reason { get; set; }
}