$ErrorActionPreference = 'Stop'

Set-Location (Split-Path $PSScriptRoot -Parent)

$tmpDir = Join-Path $PWD '.tmp-hook-check'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$allowFile = Join-Path $tmpDir 'allow.json'
$denyFile = Join-Path $tmpDir 'deny.json'
$qualityFile = Join-Path $tmpDir 'quality.json'
$artifactPath = Join-Path $PWD '.github\hooks\artifacts\recursive-architect.md'
$qualityLogPath = Join-Path $PWD '.github\hooks\logs\subagent-quality.jsonl'

function Invoke-HookScript {
    param(
        [string]$ScriptPath,
        [string]$InputPath
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
    $psi.WorkingDirectory = $PWD.Path
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['COPILOT_HOOK_INPUT_PATH'] = $InputPath

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
        throw "Hook process failed for $ScriptPath: $stderr"
    }

    return $stdout.Trim()
}

@{
    toolName = 'edit'
    toolInput = @{ filePath = $artifactPath }
    agent_type = 'recursive-architect'
} | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path $allowFile -NoNewline

@{
    toolName = 'edit'
    toolInput = @{ filePath = (Join-Path $PWD 'src\main\ai-service.js') }
    agent_type = 'recursive-architect'
} | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path $denyFile -NoNewline

@'
## Recommended Approach
Use the ai-service extraction seam and keep the compatibility facade stable.

## Files to Reuse
- src/main/ai-service.js
- src/main/ai-service/visual-context.js

## Constraints and Risks
- Source-based regression tests inspect ai-service.js text directly.
'@ | Set-Content -Path $artifactPath -NoNewline

@{
    agent_type = 'recursive-architect'
    agent_id = 'sim-architect'
    cwd = (Join-Path $PWD '.github\hooks')
    stop_hook_active = $true
} | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path $qualityFile -NoNewline

$allowRaw = Invoke-HookScript '.\.github\hooks\scripts\security-check.ps1' $allowFile
$denyRaw = Invoke-HookScript '.\.github\hooks\scripts\security-check.ps1' $denyFile
$deny = $denyRaw | ConvertFrom-Json

Invoke-HookScript '.\.github\hooks\scripts\subagent-quality-gate.ps1' $qualityFile | Out-Null

$quality = Get-Content -Path $qualityLogPath | Select-Object -Last 1 | ConvertFrom-Json

if (-not [string]::IsNullOrWhiteSpace(($allowRaw | Out-String))) {
    throw 'Expected empty allow response for artifact mutation'
}

if ($deny.permissionDecision -ne 'deny') {
    throw "Expected deny response for non-artifact edit, got '$($deny.permissionDecision)'"
}

if ($quality.status -ne 'pass') {
    throw "Expected quality gate pass from artifact evidence, got '$($quality.status)'"
}

if ($quality.evidenceSource -notmatch 'artifact') {
    throw "Expected artifact-backed evidence source, got '$($quality.evidenceSource)'"
}

Write-Host 'PASS artifact edit allowed for recursive-architect'
Write-Host 'PASS non-artifact edit denied for recursive-architect'
Write-Host "PASS quality gate accepted artifact evidence ($($quality.evidenceSource))"