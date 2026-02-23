$ErrorActionPreference = "Stop"
try {
    $hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $reason = $hookInput.reason

    $logsDir = Join-Path $hookInput.cwd "logs"
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

    $logFile = Join-Path $logsDir "session.log"
    $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | SESSION_END | reason=$reason"
    Add-Content -Path $logFile -Value $entry

    exit 0
} catch {
    exit 0
}
