$ErrorActionPreference = "Stop"
try {
    function Test-IsAllowedArtifactMutation {
        param(
            [string]$AgentType,
            $ToolParams,
            $RawPayload
        )

        if (-not $AgentType) { return $false }
        $escapedAgent = [Regex]::Escape($AgentType)
        $artifactPattern = "[.]github[\\/]+hooks[\\/]+artifacts[\\/]+$escapedAgent[.]md"

        $candidates = @()
        if ($ToolParams) {
            foreach ($name in @('filePath', 'path', 'targetFile', 'uri', 'resource')) {
                $value = $ToolParams.$name
                if ($value) { $candidates += [string]$value }
            }
            try {
                $candidates += ($ToolParams | ConvertTo-Json -Compress -Depth 10)
            } catch {
            }
        }

        if ($RawPayload) {
            if ($RawPayload -is [string]) {
                $candidates += $RawPayload
            } else {
                try {
                    $candidates += ($RawPayload | ConvertTo-Json -Compress -Depth 10)
                } catch {
                }
            }
        }

        foreach ($candidate in $candidates) {
            if ($candidate -match $artifactPattern) {
                return $true
            }
        }

        return $false
    }

    $rawInput = if ($env:COPILOT_HOOK_INPUT_PATH -and (Test-Path $env:COPILOT_HOOK_INPUT_PATH)) {
        Get-Content -Path $env:COPILOT_HOOK_INPUT_PATH -Raw -ErrorAction Stop
    } else {
        [Console]::In.ReadToEnd()
    }

    $hookData = $rawInput | ConvertFrom-Json
    $toolName = $hookData.toolName
    if (-not $toolName) { $toolName = $hookData.tool_name }

    $toolPayload = $hookData.toolArgs
    if (-not $toolPayload) { $toolPayload = $hookData.tool_input }
    if (-not $toolPayload) { $toolPayload = $hookData.toolInput }

    $agentType = $hookData.agentType
    if (-not $agentType) { $agentType = $hookData.agent_type }

    # Parse tool arguments
    $toolParams = $null
    if ($toolPayload) {
        if ($toolPayload -is [string]) {
            $toolParams = $toolPayload | ConvertFrom-Json -ErrorAction SilentlyContinue
        } else {
            $toolParams = $toolPayload
        }
    }

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

    $normalizedTool = ""
    if ($toolName) { $normalizedTool = $toolName.ToString().ToLowerInvariant() }

    $readOnlyAgents = @('recursive-researcher', 'recursive-architect')
    $noWriteAgents = @('recursive-researcher', 'recursive-architect', 'recursive-verifier', 'recursive-diagnostician', 'recursive-vision-operator')
    $noExecuteAgents = @('recursive-researcher', 'recursive-architect')

    $isArtifactMutation = Test-IsAllowedArtifactMutation -AgentType $agentType -ToolParams $toolParams -RawPayload $toolPayload

    if ($agentType -and $noWriteAgents -contains $agentType -and ($normalizedTool -eq 'edit' -or $normalizedTool -eq 'write') -and -not $isArtifactMutation) {
        $output = @{
            permissionDecision = "deny"
            permissionDecisionReason = "Blocked by security hook: $agentType is read-only for file mutations"
        } | ConvertTo-Json -Compress
        Write-Output $output
        exit 0
    }

    if ($agentType -and $noExecuteAgents -contains $agentType -and ($normalizedTool -eq 'bash' -or $normalizedTool -eq 'execute' -or $normalizedTool -eq 'shell')) {
        $output = @{
            permissionDecision = "deny"
            permissionDecisionReason = "Blocked by security hook: $agentType is not allowed to run shell or execute commands"
        } | ConvertTo-Json -Compress
        Write-Output $output
        exit 0
    }

    if ($normalizedTool -eq "bash" -or $normalizedTool -eq "execute" -or $normalizedTool -eq "shell") {
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
