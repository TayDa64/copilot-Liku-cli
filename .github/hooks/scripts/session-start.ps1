$ErrorActionPreference = "Stop"
try {
    $hookInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $timestamp = $hookInput.timestamp
    $source = $hookInput.source
    $cwd = $hookInput.cwd

    $logsDir = Join-Path $cwd "logs"
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

    $logFile = Join-Path $logsDir "session.log"
    $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | SESSION_START | source=$source | cwd=$cwd"
    Add-Content -Path $logFile -Value $entry

    # Initialize agent state if it doesn't exist
    $stateFile = Join-Path $cwd ".github" "agent_state.json"
    if (-not (Test-Path $stateFile)) {
        $state = @{
            version = "1.0.0"
            queue = @()
            inProgress = @()
            completed = @()
            failed = @()
            agents = @{}
            sessions = @()
        } | ConvertTo-Json -Depth 4
        Set-Content -Path $stateFile -Value $state
    }

    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
