using System.Text;
using System.Text.Json;

namespace AutomationHost.Rpc;

internal sealed class RpcServer : IAsyncDisposable
{
    private readonly Stream input;
    private readonly Stream output;
    private readonly TextWriter errorWriter;
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly AutomationRpcService service;
    private Task? processingTask;

    public RpcServer(Stream input, Stream output, TextWriter errorWriter)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(errorWriter);

        this.input = input;
        this.output = output;
        this.errorWriter = errorWriter;
        service = new AutomationRpcService(errorWriter, WriteNotificationAsync);
    }

    public Task Completion => service.Completion;

    public Task StartAsync()
    {
        processingTask = ProcessLoopAsync();
        return service.NotifyReadyAsync();
    }

    public async ValueTask DisposeAsync()
    {
        if (processingTask is not null)
        {
            try
            {
                await processingTask;
            }
            catch
            {
                // ProcessLoopAsync already reports to stderr and completion.
            }
        }

        writeLock.Dispose();
        await service.DisposeAsync();
    }

    private async Task ProcessLoopAsync()
    {
        try
        {
            while (true)
            {
                var body = await ReadMessageBodyAsync();
                if (body is null)
                {
                    break;
                }

                JsonRpcRequestMessage? request;
                try
                {
                    request = JsonSerializer.Deserialize(body, AutomationJsonSerializerContext.Default.JsonRpcRequestMessage);
                }
                catch (Exception ex)
                {
                    errorWriter.WriteLine($"[AutomationHost] Failed to deserialize request: {ex.Message}");
                    continue;
                }

                if (request is null || string.IsNullOrWhiteSpace(request.Method))
                {
                    continue;
                }

                await HandleRequestAsync(request);
            }
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] RPC loop failed: {ex}");
        }
        finally
        {
            await service.DisposeAsync();
        }
    }

    private async Task HandleRequestAsync(JsonRpcRequestMessage request)
    {
        var idElement = request.Id.GetValueOrDefault();
        var hasId = request.Id is JsonElement && idElement.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined;

        try
        {
            var result = service.CreateSuccessResult(request.Method, request.Params);
            if (hasId)
            {
                await WriteSuccessResponseAsync(idElement, result);
            }
        }
        catch (InvalidOperationException ex)
        {
            if (hasId)
            {
                await WriteErrorResponseAsync(idElement, -32601, ex.Message);
            }
        }
        catch (Exception ex)
        {
            errorWriter.WriteLine($"[AutomationHost] Request '{request.Method}' failed: {ex}");
            if (hasId)
            {
                await WriteErrorResponseAsync(idElement, -32000, ex.Message);
            }
        }
    }

    private async Task<byte[]?> ReadMessageBodyAsync()
    {
        var headerBytes = new List<byte>();
        while (true)
        {
            var next = new byte[1];
            var bytesRead = await input.ReadAsync(next, 0, 1);
            if (bytesRead == 0)
            {
                return headerBytes.Count == 0 ? null : throw new EndOfStreamException("Unexpected EOF while reading JSON-RPC headers.");
            }

            headerBytes.Add(next[0]);
            var count = headerBytes.Count;
            if (count >= 4
                && headerBytes[count - 4] == '\r'
                && headerBytes[count - 3] == '\n'
                && headerBytes[count - 2] == '\r'
                && headerBytes[count - 1] == '\n')
            {
                break;
            }
        }

        var headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
        var contentLength = ParseContentLength(headerText);
        if (contentLength <= 0)
        {
            throw new InvalidDataException($"Invalid Content-Length header: {headerText}");
        }

        var body = new byte[contentLength];
        var offset = 0;
        while (offset < contentLength)
        {
            var read = await input.ReadAsync(body, offset, contentLength - offset);
            if (read == 0)
            {
                throw new EndOfStreamException("Unexpected EOF while reading JSON-RPC body.");
            }

            offset += read;
        }

        return body;
    }

    private static int ParseContentLength(string headerText)
    {
        foreach (var line in headerText.Split(new[] { "\r\n" }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                var value = line.Substring("Content-Length:".Length).Trim();
                if (int.TryParse(value, out var contentLength))
                {
                    return contentLength;
                }
            }
        }

        return -1;
    }

    private Task WriteNotificationAsync(string method, JsonElement payload)
    {
        return WriteJsonRpcMessageAsync(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", method);
            writer.WritePropertyName("params");
            payload.WriteTo(writer);
            writer.WriteEndObject();
        });
    }

    private Task WriteSuccessResponseAsync(JsonElement id, JsonElement result)
    {
        return WriteJsonRpcMessageAsync(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            id.WriteTo(writer);
            writer.WritePropertyName("result");
            result.WriteTo(writer);
            writer.WriteEndObject();
        });
    }

    private Task WriteErrorResponseAsync(JsonElement id, int code, string message)
    {
        return WriteJsonRpcMessageAsync(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            id.WriteTo(writer);
            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteNumber("code", code);
            writer.WriteString("message", message);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private async Task WriteJsonRpcMessageAsync(Action<Utf8JsonWriter> writePayload)
    {
        await writeLock.WaitAsync();
        try
        {
            using var bodyStream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(bodyStream))
            {
                writePayload(writer);
            }

            var body = bodyStream.ToArray();
            var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
            await output.WriteAsync(header, 0, header.Length);
            await output.WriteAsync(body, 0, body.Length);
            await output.FlushAsync();
        }
        finally
        {
            writeLock.Release();
        }
    }
}