$ErrorActionPreference = "Stop"
try {
    $rawInput = if ($env:COPILOT_HOOK_INPUT_PATH -and (Test-Path $env:COPILOT_HOOK_INPUT_PATH)) {
        Get-Content -Path $env:COPILOT_HOOK_INPUT_PATH -Raw -ErrorAction Stop
    } else {
        [Console]::In.ReadToEnd()
    }

    $hookInput = $rawInput | ConvertFrom-Json

    $stopHookActive = $hookInput.stop_hook_active
    if ($null -eq $stopHookActive) { $stopHookActive = $hookInput.stopHookActive }

    $agentType = $hookInput.agent_type
    if (-not $agentType) { $agentType = $hookInput.agentType }

    $agentId = $hookInput.agent_id
    if (-not $agentId) { $agentId = $hookInput.agentId }

    $agentTranscriptPath = $hookInput.agent_transcript_path
    if (-not $agentTranscriptPath) { $agentTranscriptPath = $hookInput.agentTranscriptPath }

    $lastAssistantMessage = $hookInput.last_assistant_message
    if (-not $lastAssistantMessage) { $lastAssistantMessage = $hookInput.lastAssistantMessage }
    if (-not $lastAssistantMessage) { $lastAssistantMessage = "" }

    $artifactsDir = Join-Path $hookInput.cwd "artifacts"
    $artifactPath = $null
    $artifactText = ""
    if ($agentType) {
        $artifactPath = Join-Path $artifactsDir "$agentType.md"
        if (Test-Path $artifactPath) {
            try {
                $artifactText = Get-Content -Path $artifactPath -Raw -ErrorAction Stop
            } catch {
                $artifactText = ""
            }
        }
    }

    $transcriptText = ""
    if ($agentTranscriptPath -and (Test-Path $agentTranscriptPath)) {
        try {
            $transcriptText = Get-Content -Path $agentTranscriptPath -Raw -ErrorAction Stop
        } catch {
            $transcriptText = ""
        }
    }

    $evidenceParts = @()
    if ($artifactText) { $evidenceParts += $artifactText }
    if ($lastAssistantMessage) { $evidenceParts += $lastAssistantMessage }
    if ($transcriptText) { $evidenceParts += $transcriptText }
    $evidenceText = ($evidenceParts -join "`n`n")

    $logsDir = Join-Path $hookInput.cwd "logs"
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }

    $logFile = Join-Path $logsDir "subagent.log"
    $qualityLog = Join-Path $logsDir "subagent-quality.jsonl"

    $checks = @()
    switch ($agentType) {
        'recursive-builder' {
            $checks = @(
                @{ Label = 'changed-files'; Pattern = 'Changed Files' },
                @{ Label = 'local-proofs'; Pattern = 'Local Proofs|local proofs' },
                @{ Label = 'unresolved-risks'; Pattern = 'Unresolved Risks|unresolved risks' }
            )
        }
        'recursive-researcher' {
            $checks = @(
                @{ Label = 'sources'; Pattern = 'Sources Examined|Sources' },
                @{ Label = 'findings'; Pattern = 'Key Findings|Findings' },
                @{ Label = 'next-agent'; Pattern = 'Recommended Next Agent|Next Agent' }
            )
        }
        'recursive-architect' {
            $checks = @(
                @{ Label = 'recommended-approach'; Pattern = 'Recommended Approach|Recommended Path' },
                @{ Label = 'reuse-targets'; Pattern = 'Reuse|Existing Patterns|Files to Reuse' },
                @{ Label = 'constraints'; Pattern = 'Constraints|Risks' }
            )
        }
        'recursive-verifier' {
            $checks = @(
                @{ Label = 'verification-report'; Pattern = 'Verification Report' },
                @{ Label = 'verdict'; Pattern = 'Verdict: PASS|Verdict: FAIL|## Verdict' },
                @{ Label = 'evidence'; Pattern = 'Failing Commands or Evidence|Phase 1|Phase 2' }
            )
        }
        'recursive-diagnostician' {
            $checks = @(
                @{ Label = 'root-cause'; Pattern = 'Root Cause|root cause' },
                @{ Label = 'evidence'; Pattern = 'Evidence|evidence' },
                @{ Label = 'fix-path'; Pattern = 'Fix Path|Smallest Fix|Recommended Fix' }
            )
        }
        'recursive-vision-operator' {
            $checks = @(
                @{ Label = 'observed-state'; Pattern = 'Observed State|Current UI State|Observed UI State' },
                @{ Label = 'evidence'; Pattern = 'Evidence|Artifacts|Screenshot|UIA|DOM' },
                @{ Label = 'next-safe-action'; Pattern = 'Next Safe Action|Next Action|Blockers' }
            )
        }
    }

    $missingChecks = @()
    $payloadMissingEvidence = [string]::IsNullOrWhiteSpace($evidenceText)

    if (-not $payloadMissingEvidence) {
        foreach ($check in $checks) {
            if ($evidenceText -notmatch $check.Pattern) {
                $missingChecks += $check.Label
            }
        }
    }

    $status = if ($payloadMissingEvidence -or $missingChecks.Count -eq 0) { 'pass' } else { 'warn' }
    $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | SUBAGENT_STOP | $agentType | $status"
    Add-Content -Path $logFile -Value $entry

    $qualityEntry = @{
        timestamp = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ')
        agentId = $agentId
        agentType = $agentType
        status = $status
        missingChecks = $missingChecks
        enforcementMode = if ($payloadMissingEvidence) { 'payload-missing-evidence' } else { 'content-checks' }
        evidenceSource = if ($artifactText -and ($lastAssistantMessage -or $transcriptText)) { 'artifact+payload' } elseif ($artifactText) { 'artifact' } elseif ($lastAssistantMessage -and $transcriptText) { 'combined' } elseif ($transcriptText) { 'agentTranscriptPath' } else { 'lastAssistantMessage' }
        artifactPath = $artifactPath
        artifactExists = if ($artifactPath) { Test-Path $artifactPath } else { $false }
        artifactLength = $artifactText.Length
        lastAssistantMessageLength = $lastAssistantMessage.Length
        transcriptLength = $transcriptText.Length
        transcriptPathPresent = [bool]$agentTranscriptPath
        transcriptPathExists = if ($agentTranscriptPath) { Test-Path $agentTranscriptPath } else { $false }
        hookInputKeys = @($hookInput.PSObject.Properties.Name)
    } | ConvertTo-Json -Compress
    Add-Content -Path $qualityLog -Value $qualityEntry

    if (-not $stopHookActive -and -not $payloadMissingEvidence -and $missingChecks.Count -gt 0) {
        $reason = "$agentType must return evidence before stopping. Missing sections: $($missingChecks -join ', ')."
        $output = @{
            decision = 'block'
            reason = $reason
        } | ConvertTo-Json -Compress
        Write-Output $output
        exit 0
    }

    exit 0
} catch {
    exit 0
}
