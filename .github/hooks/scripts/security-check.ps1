$ErrorActionPreference = "Stop"
try {
    $hookData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $toolName = $hookData.toolName
    $toolPayload = $hookData.toolArgs

    # Parse tool arguments
    $toolParams = $null
    if ($toolPayload) { $toolParams = $toolPayload | ConvertFrom-Json -ErrorAction SilentlyContinue }

    # Dangerous command patterns to block
    $dangerousPatterns = @(
        'rm\s+-rf\s+/',
        'Remove-Item.*-Recurse.*-Force.*(C:\\|/)',
        'format\s+[A-Z]:',
        'DROP\s+TABLE',
        'DROP\s+DATABASE',
        'git\s+push\s+--force',
        'git\s+reset\s+--hard',
        'del\s+/s\s+/q\s+C:\\',
        'shutdown\s+',
        'mkfs\.',
        'dd\s+if=.*of=/dev/'
    )

    if ($toolName -eq "bash" -or $toolName -eq "execute" -or $toolName -eq "shell") {
        $command = ""
        if ($toolParams -and $toolParams.command) { $command = $toolParams.command }

        foreach ($pattern in $dangerousPatterns) {
            if ($command -match $pattern) {
                $output = @{
                    permissionDecision = "deny"
                    permissionDecisionReason = "Blocked by security hook: matches dangerous pattern '$pattern'"
                } | ConvertTo-Json -Compress
                Write-Output $output
                exit 0
            }
        }
    }

    # Allow by default
    exit 0
} catch {
    # On error, allow (fail open to not block workflows)
    exit 0
}
