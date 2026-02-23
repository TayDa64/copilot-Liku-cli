$ErrorActionPreference = "Stop"
try {
    $hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $toolName = $hookInput.toolName
    $toolArgs = $hookInput.toolArgs
    $resultType = $hookInput.toolResult.resultType

    $logsDir = Join-Path $hookInput.cwd "logs"
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

    $logFile = Join-Path $logsDir "tool-audit.jsonl"
    $entry = @{
        timestamp = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')
        tool = $toolName
        result = $resultType
    } | ConvertTo-Json -Compress

    Add-Content -Path $logFile -Value $entry
    exit 0
} catch {
    exit 0
}
