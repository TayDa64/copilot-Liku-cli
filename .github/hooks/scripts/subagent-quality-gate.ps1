$ErrorActionPreference = "Stop"
try {
    $hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json

    $logsDir = Join-Path $hookInput.cwd "logs"
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

    $logFile = Join-Path $logsDir "subagent.log"
    $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | SUBAGENT_STOP | result available for parent review"
    Add-Content -Path $logFile -Value $entry

    # Output is ignored for subagentStop hooks per the docs,
    # but we log the event for observability
    exit 0
} catch {
    exit 0
}
