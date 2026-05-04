using AutomationHost.Rpc;

return await AutomationHostProgram.RunAsync();

internal static class AutomationHostProgram
{
	public static async Task<int> RunAsync()
	{
		try
		{
			using var input = Console.OpenStandardInput();
			using var output = Console.OpenStandardOutput();

			await using var server = new RpcServer(input, output, Console.Error);
			await server.StartAsync();
			await server.Completion;
			return 0;
		}
		catch (Exception ex)
		{
			Console.Error.WriteLine($"[AutomationHost] Fatal startup error: {ex}");
			return 1;
		}
	}
}
