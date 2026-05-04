using System.Text.Json;

namespace AutomationHost.Rpc;

internal sealed class AutomationRpcService : IAsyncDisposable
{
    private readonly TextWriter errorWriter;
    private readonly Func<string, JsonElement, Task> notificationWriter;
    private readonly TaskCompletionSource completionSource = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly string instanceId = Guid.NewGuid().ToString("N");
    private int shutdownSignaled;

    public AutomationRpcService(TextWriter errorWriter, Func<string, JsonElement, Task> notificationWriter)
    {
        this.errorWriter = errorWriter;
        this.notificationWriter = notificationWriter;
    }

    public Task Completion => completionSource.Task;

    public Task NotifyReadyAsync()
    {
        return NotifyAsync("host/ready", CreateReadyNotification());
    }

    public PingResponse Ping(PingRequest? request = null)
    {
        return new PingResponse
        {
            Message = string.IsNullOrWhiteSpace(request?.Message) ? "pong" : request!.Message!,
            HostVersion = "0.1.0-phase0",
            InstanceId = instanceId,
            ProcessId = Environment.ProcessId,
            TimestampUtc = DateTimeOffset.UtcNow
        };
    }

    public ShutdownResponse Shutdown(ShutdownRequest? request = null)
    {
        var reason = string.IsNullOrWhiteSpace(request?.Reason) ? "client-request" : request!.Reason!;
        SignalShutdown(reason);

        return new ShutdownResponse
        {
            Acknowledged = true,
            Reason = reason,
            TimestampUtc = DateTimeOffset.UtcNow
        };
    }

    public InvokeResponse Invoke(InvokeRequest request)
    {
        if (request is null)
        {
            return Error("invalid-request", "Missing invoke request payload.");
        }

        return Dispatch(request.Method, request.Params);
    }

    public InvokeBatchResponse InvokeBatch(InvokeBatchRequest? request)
    {
        var invocations = request?.Invocations ?? Array.Empty<InvokeRequest>();
        var results = invocations.Select(item => Dispatch(item.Method, item.Params)).ToArray();
        return new InvokeBatchResponse
        {
            Count = results.Length,
            Results = results
        };
    }

    public ValueTask DisposeAsync()
    {
        if (!completionSource.Task.IsCompleted)
        {
            completionSource.TrySetResult();
        }

        return ValueTask.CompletedTask;
    }

    public JsonElement CreateSuccessResult(string method, JsonElement? parameters)
    {
        return (method ?? string.Empty).Trim() switch
        {
            "window.getForegroundInfo" => ToJsonElement(WindowModule.GetForegroundWindowInfo()),
            "window.getInfoByHandle" => ToJsonElement(WindowModule.GetWindowInfoByHandle(ParseWindowHandle(parameters))),
            "ping" => ToJsonElement(Ping(ParsePingRequest(parameters))),
            "shutdown" => ToJsonElement(Shutdown(ParseShutdownRequest(parameters))),
            "invoke" => ToJsonElement(Invoke(ParseInvokeRequest(parameters))),
            "invokeBatch" => ToJsonElement(InvokeBatch(ParseInvokeBatchRequest(parameters))),
            _ => throw new InvalidOperationException($"Method '{method}' is not implemented in Phase 0.")
        };
    }

    private long ParseWindowHandle(JsonElement? parameters)
    {
        if (parameters is not JsonElement element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return 0;
        }

        try
        {
            if (element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var rawValue))
            {
                return rawValue;
            }

            if (element.ValueKind == JsonValueKind.Object)
            {
                if (element.TryGetProperty("hwnd", out var hwndProperty) && hwndProperty.TryGetInt64(out var hwnd))
                {
                    return hwnd;
                }
                if (element.TryGetProperty("handle", out var handleProperty) && handleProperty.TryGetInt64(out var handle))
                {
                    return handle;
                }
            }
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Failed to parse window handle params: {ex.Message}");
        }

        return 0;
    }

    private InvokeResponse Dispatch(string? method, JsonElement? parameters)
    {
        return (method ?? string.Empty).Trim() switch
        {
            "ping" => Success(Ping(parameters)),
            "shutdown" => Success(Shutdown(ParseShutdownRequest(parameters))),
            _ => Error("not-implemented", $"Method '{method}' is not implemented in Phase 0.")
        };
    }

    private InvokeRequest ParseInvokeRequest(JsonElement? parameters)
    {
        if (parameters is not JsonElement element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return new InvokeRequest();
        }

        try
        {
            return element.Deserialize(AutomationJsonSerializerContext.Default.InvokeRequest) ?? new InvokeRequest();
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Failed to parse invoke params: {ex.Message}");
            return new InvokeRequest();
        }
    }

    private InvokeBatchRequest ParseInvokeBatchRequest(JsonElement? parameters)
    {
        if (parameters is not JsonElement element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return new InvokeBatchRequest();
        }

        try
        {
            return element.Deserialize(AutomationJsonSerializerContext.Default.InvokeBatchRequest) ?? new InvokeBatchRequest();
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Failed to parse invokeBatch params: {ex.Message}");
            return new InvokeBatchRequest();
        }
    }

    private PingRequest? ParsePingRequest(JsonElement? parameters)
    {
        if (parameters is not JsonElement element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        try
        {
            return element.Deserialize(AutomationJsonSerializerContext.Default.PingRequest);
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Failed to parse ping params: {ex.Message}");
            return null;
        }
    }

    private ShutdownRequest? ParseShutdownRequest(JsonElement? parameters)
    {
        if (parameters is not JsonElement element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        try
        {
            return element.Deserialize(AutomationJsonSerializerContext.Default.ShutdownRequest);
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Failed to parse shutdown params: {ex.Message}");
            return null;
        }
    }

    private PingResponse Ping(JsonElement? parameters)
    {
        return Ping(ParsePingRequest(parameters));
    }

    private InvokeResponse Success(object? result)
    {
        return new InvokeResponse
        {
            Success = true,
            Result = result
        };
    }

    private static InvokeResponse Error(string code, string message)
    {
        return new InvokeResponse
        {
            Success = false,
            ErrorCode = code,
            ErrorMessage = message
        };
    }

    private HostLifecycleNotification CreateReadyNotification()
    {
        return new HostLifecycleNotification
        {
            State = "ready",
            InstanceId = instanceId,
            ProcessId = Environment.ProcessId,
            TimestampUtc = DateTimeOffset.UtcNow
        };
    }

    private static JsonElement ToJsonElement(PingResponse value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.PingResponse);
    }

    private static JsonElement ToJsonElement(ShutdownResponse value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.ShutdownResponse);
    }

    private static JsonElement ToJsonElement(InvokeResponse value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.InvokeResponse);
    }

    private static JsonElement ToJsonElement(InvokeBatchResponse value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.InvokeBatchResponse);
    }

    private static JsonElement ToJsonElement(WindowInfoResult value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.WindowInfoResult);
    }

    private static JsonElement ToJsonElement(HostLifecycleNotification value)
    {
        return JsonSerializer.SerializeToElement(value, AutomationJsonSerializerContext.Default.HostLifecycleNotification);
    }

    private void SignalShutdown(string reason)
    {
        if (Interlocked.Exchange(ref shutdownSignaled, 1) == 1)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            await NotifyAsync("host/stopping", new HostLifecycleNotification
            {
                State = "stopping",
                Reason = reason,
                InstanceId = instanceId,
                ProcessId = Environment.ProcessId,
                TimestampUtc = DateTimeOffset.UtcNow
            });

            completionSource.TrySetResult();
        });
    }

    private async Task NotifyAsync(string method, HostLifecycleNotification payload)
    {
        try
        {
            await notificationWriter(method, ToJsonElement(payload));
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Notification '{method}' failed: {ex.Message}");
        }
    }
}