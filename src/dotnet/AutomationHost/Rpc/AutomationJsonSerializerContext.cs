using System.Text.Json.Serialization;

namespace AutomationHost.Rpc;

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(JsonRpcRequestMessage))]
[JsonSerializable(typeof(JsonRpcError))]
[JsonSerializable(typeof(WindowInfoResult))]
[JsonSerializable(typeof(InvokeRequest))]
[JsonSerializable(typeof(InvokeResponse))]
[JsonSerializable(typeof(InvokeBatchRequest))]
[JsonSerializable(typeof(InvokeBatchResponse))]
[JsonSerializable(typeof(HostLifecycleNotification))]
[JsonSerializable(typeof(PingRequest))]
[JsonSerializable(typeof(PingResponse))]
[JsonSerializable(typeof(ShutdownRequest))]
[JsonSerializable(typeof(ShutdownResponse))]
internal partial class AutomationJsonSerializerContext : JsonSerializerContext
{
}