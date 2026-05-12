param(
  [int]$CdpPort = 9222,
  [switch]$ForceRendererAccessibility,
  [int]$CloseTimeoutMs = 10000,
  [int]$LaunchSettleMs = 750,
  [switch]$AllowForceKillExisting,
  [string]$AppUserModelId = '',
  [string]$ExecutablePath = '',
  [string]$StatusFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$script:CurrentPhase = 'starting'
$script:StatusFilePath = if ([string]::IsNullOrWhiteSpace($StatusFile)) {
  [string]$env:LIKU_TRADINGVIEW_AUTOMATION_WRAPPER_STATUS_FILE
} else {
  [string]$StatusFile
}

function Resolve-OptionalPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ''
  }

  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue.Trim())
  try {
    return [System.IO.Path]::GetFullPath($expanded)
  } catch {
    return $expanded
  }
}

function Write-WrapperStatus(
  [string]$Status,
  [string]$Phase,
  [string]$Message,
  [hashtable]$Extra = @{}
) {
  if ([string]::IsNullOrWhiteSpace($script:StatusFilePath)) {
    return
  }

  $statusFilePath = Resolve-OptionalPath $script:StatusFilePath
  $statusDir = Split-Path -Parent $statusFilePath
  if (-not [string]::IsNullOrWhiteSpace($statusDir)) {
    New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
  }

  $payload = [ordered]@{
    status = [string]$Status
    phase = [string]$Phase
    message = [string]$Message
    updatedAt = (Get-Date).ToString('o')
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusFilePath -Encoding UTF8
}

function Get-InstalledTradingViewPackageInfo() {
  $package = Get-AppxPackage *TradingView* -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $package) {
    return $null
  }

  $packageFamilyName = [string]$package.PackageFamilyName
  $preferredStartApp = $null
  if (-not [string]::IsNullOrWhiteSpace($packageFamilyName) -and (Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue)) {
    $startApps = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object {
      $appId = [string]$_.AppID
      $name = [string]$_.Name
      ($packageFamilyName -and $appId.StartsWith($packageFamilyName + '!')) -or $name -like '*TradingView*'
    })
    $preferredStartApp = $startApps | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.AppID) } | Select-Object -First 1
  }

  $detectedExecutablePath = ''
  if (-not [string]::IsNullOrWhiteSpace([string]$package.InstallLocation)) {
    $candidateExecutablePath = Join-Path ([string]$package.InstallLocation) 'TradingView.exe'
    if (Test-Path -LiteralPath $candidateExecutablePath) {
      $detectedExecutablePath = $candidateExecutablePath
    }
  }

  return [PSCustomObject]@{
    name = [string]$package.Name
    packageFullName = [string]$package.PackageFullName
    packageFamilyName = $packageFamilyName
    installLocation = [string]$package.InstallLocation
    executablePath = $detectedExecutablePath
    appUserModelId = if ($preferredStartApp) { [string]$preferredStartApp.AppID } else { '' }
  }
}

function Get-TradingViewLaunchTarget([string]$RequestedExecutablePath, [string]$RequestedAppUserModelId) {
  $resolvedRequestedPath = Resolve-OptionalPath $RequestedExecutablePath
  $normalizedRequestedAppUserModelId = [string]$RequestedAppUserModelId
  if (-not [string]::IsNullOrWhiteSpace($normalizedRequestedAppUserModelId)) {
    $normalizedRequestedAppUserModelId = $normalizedRequestedAppUserModelId.Trim()
  }

  $packageInfo = Get-InstalledTradingViewPackageInfo
  if (-not [string]::IsNullOrWhiteSpace($normalizedRequestedAppUserModelId)) {
    return [PSCustomObject]@{
      launchMode = 'packaged-app-activation'
      executablePath = if ($packageInfo) { [string]$packageInfo.executablePath } else { '' }
      workingDirectory = if ($packageInfo -and -not [string]::IsNullOrWhiteSpace([string]$packageInfo.executablePath)) { Split-Path -Parent ([string]$packageInfo.executablePath) } else { '' }
      appUserModelId = $normalizedRequestedAppUserModelId
      packageFamilyName = if ($packageInfo) { [string]$packageInfo.packageFamilyName } else { '' }
      installLocation = if ($packageInfo) { [string]$packageInfo.installLocation } else { '' }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($resolvedRequestedPath)) {
    if (-not (Test-Path -LiteralPath $resolvedRequestedPath)) {
      throw "TradingView executable was not found: $resolvedRequestedPath"
    }

    return [PSCustomObject]@{
      launchMode = 'direct-executable'
      executablePath = $resolvedRequestedPath
      workingDirectory = Split-Path -Parent $resolvedRequestedPath
      appUserModelId = ''
      packageFamilyName = ''
      installLocation = ''
    }
  }

  if ($packageInfo) {
    if (-not [string]::IsNullOrWhiteSpace([string]$packageInfo.appUserModelId)) {
      return [PSCustomObject]@{
        launchMode = 'packaged-app-activation'
        executablePath = [string]$packageInfo.executablePath
        workingDirectory = if (-not [string]::IsNullOrWhiteSpace([string]$packageInfo.executablePath)) { Split-Path -Parent ([string]$packageInfo.executablePath) } else { '' }
        appUserModelId = [string]$packageInfo.appUserModelId
        packageFamilyName = [string]$packageInfo.packageFamilyName
        installLocation = [string]$packageInfo.installLocation
      }
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$packageInfo.executablePath)) {
      return [PSCustomObject]@{
        launchMode = 'direct-executable'
        executablePath = [string]$packageInfo.executablePath
        workingDirectory = Split-Path -Parent ([string]$packageInfo.executablePath)
        appUserModelId = ''
        packageFamilyName = [string]$packageInfo.packageFamilyName
        installLocation = [string]$packageInfo.installLocation
      }
    }
  }

  throw 'TradingView is not installed or its packaged launch identity could not be resolved.'
}

function Ensure-ApplicationActivationInterop() {
  if ('Liku.AppModel.Launcher' -as [type]) {
    return
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace Liku.AppModel {
    [Flags]
    public enum ActivateOptions {
        None = 0,
        DesignMode = 0x1,
        NoErrorUI = 0x2,
        NoSplashScreen = 0x4
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    public interface IApplicationActivationManager {
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        int ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);

        int ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            out uint processId);
    }

    public static class Launcher {
        public static int Activate(string appUserModelId, string arguments, out uint processId) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            return manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.NoErrorUI, out processId);
        }
    }
}
"@ -Language CSharp
}

function Quote-CommandLineArgument([string]$Value) {
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return '""'
  }
  if ($text -notmatch '[\s"]') {
    return $text
  }
  return '"' + $text.Replace('"', '\"') + '"'
}

function Join-CommandLineArguments([string[]]$Arguments) {
  if (-not $Arguments -or @($Arguments).Count -eq 0) {
    return ''
  }

  return [string]::Join(' ', @($Arguments | ForEach-Object { Quote-CommandLineArgument ([string]$_) }))
}

function Start-PackagedTradingViewApplication([string]$ResolvedAppUserModelId, [string[]]$LaunchArguments) {
  if ([string]::IsNullOrWhiteSpace($ResolvedAppUserModelId)) {
    throw 'TradingView packaged launch target is missing an AppUserModelId.'
  }

  Ensure-ApplicationActivationInterop

  $launchedProcessId = [uint32]0
  $joinedArguments = Join-CommandLineArguments -Arguments $LaunchArguments
  $hresult = [Liku.AppModel.Launcher]::Activate($ResolvedAppUserModelId, $joinedArguments, [ref]$launchedProcessId)
  if ($hresult -ne 0) {
    throw ('TradingView packaged activation failed for {0} (HRESULT 0x{1}).' -f $ResolvedAppUserModelId, ('{0:X8}' -f ([uint32]$hresult)))
  }

  return [PSCustomObject]@{
    processId = [int]$launchedProcessId
    hresult = ('0x{0:X8}' -f ([uint32]$hresult))
    arguments = $joinedArguments
  }
}

function Get-DevToolsActivePortPaths() {
  $candidatePaths = New-Object System.Collections.Generic.List[string]

  $localAppData = [string]$env:LOCALAPPDATA
  if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
    $candidatePaths.Add((Join-Path $localAppData 'Packages\TradingView.Desktop_n534cwy3pjxzj\LocalCache\Roaming\TradingView\DevToolsActivePort'))
  }

  $appData = [string]$env:APPDATA
  if (-not [string]::IsNullOrWhiteSpace($appData)) {
    $candidatePaths.Add((Join-Path $appData 'TradingView\DevToolsActivePort'))
  }

  return @($candidatePaths | Select-Object -Unique)
}

function Remove-StaleDevToolsActivePortMarkers() {
  $removedPaths = New-Object System.Collections.Generic.List[string]

  foreach ($candidatePath in (Get-DevToolsActivePortPaths)) {
    if ([string]::IsNullOrWhiteSpace($candidatePath)) {
      continue
    }
    if (-not (Test-Path -LiteralPath $candidatePath)) {
      continue
    }

    try {
      Remove-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
      $removedPaths.Add($candidatePath)
    } catch {
      continue
    }
  }

  return @($removedPaths)
}

function Get-TradingViewProcesses() {
  $result = New-Object System.Collections.Generic.List[object]
  $processRows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'TradingView.exe' } | Sort-Object ProcessId)

  foreach ($processRow in $processRows) {
    $mainWindowTitle = ''
    $mainWindowHandle = 0
    try {
      $processObject = Get-Process -Id ([int]$processRow.ProcessId) -ErrorAction Stop
      $mainWindowTitle = [string]$processObject.MainWindowTitle
      $mainWindowHandle = [int64]$processObject.MainWindowHandle
    } catch {
      $mainWindowTitle = ''
      $mainWindowHandle = 0
    }

    $result.Add([PSCustomObject]@{
      processId = [int]$processRow.ProcessId
      parentProcessId = [int]$processRow.ParentProcessId
      commandLine = [string]$processRow.CommandLine
      mainWindowTitle = $mainWindowTitle
      mainWindowHandle = $mainWindowHandle
    })
  }

  return $result.ToArray()
}

function Get-RemainingProcessIds([int[]]$ProcessIds) {
  if (-not $ProcessIds -or @($ProcessIds).Count -eq 0) {
    return @()
  }

  $remaining = New-Object System.Collections.Generic.List[int]
  foreach ($processId in $ProcessIds) {
    if ($processId -le 0) {
      continue
    }

    $processObject = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($processObject) {
      $remaining.Add([int]$processId)
    }
  }

  return @($remaining | Select-Object -Unique)
}

function Wait-ForProcessExit([int[]]$ProcessIds, [int]$TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds([Math]::Max(0, $TimeoutMs))
  $remaining = @(Get-RemainingProcessIds -ProcessIds $ProcessIds)

  while (@($remaining).Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-RemainingProcessIds -ProcessIds $ProcessIds)
  }

  return $remaining
}

try {
  $script:CurrentPhase = 'resolve-executable'
  Write-WrapperStatus -Status 'running' -Phase $script:CurrentPhase -Message 'Resolving TradingView launch target.'

  $launchTarget = Get-TradingViewLaunchTarget -RequestedExecutablePath $ExecutablePath -RequestedAppUserModelId $AppUserModelId
  $resolvedExecutablePath = [string]$launchTarget.executablePath
  $workingDirectory = [string]$launchTarget.workingDirectory
  $resolvedAppUserModelId = [string]$launchTarget.appUserModelId
  $launchMode = [string]$launchTarget.launchMode
  $packageFamilyName = [string]$launchTarget.packageFamilyName
  $launchArguments = New-Object System.Collections.Generic.List[string]
  $launchArguments.Add("--remote-debugging-port=$CdpPort")
  if ($ForceRendererAccessibility.IsPresent) {
    $launchArguments.Add('--force-renderer-accessibility')
  }

  $existingProcesses = @(Get-TradingViewProcesses)
  $existingProcessIds = @($existingProcesses | ForEach-Object { [int]$_.processId } | Where-Object { $_ -gt 0 })
  $closedProcessIds = New-Object System.Collections.Generic.List[int]
  $forcedProcessIds = New-Object System.Collections.Generic.List[int]

  if (@($existingProcessIds).Count -gt 0) {
    $script:CurrentPhase = 'closing-existing'
    Write-WrapperStatus -Status 'running' -Phase $script:CurrentPhase -Message 'Attempting to close existing TradingView processes.' -Extra @{
      executablePath = $resolvedExecutablePath
      launchMode = $launchMode
      appUserModelId = $resolvedAppUserModelId
      packageFamilyName = $packageFamilyName
      existingProcessIds = $existingProcessIds
      allowForceKillExisting = $AllowForceKillExisting.IsPresent
    }

    foreach ($processInfo in $existingProcesses) {
      if ([int64]$processInfo.mainWindowHandle -eq 0) {
        continue
      }

      try {
        $processObject = Get-Process -Id ([int]$processInfo.processId) -ErrorAction Stop
        if ($processObject.CloseMainWindow()) {
          $closedProcessIds.Add([int]$processInfo.processId)
        }
      } catch {
        continue
      }
    }

    $remainingProcessIds = Wait-ForProcessExit -ProcessIds $existingProcessIds -TimeoutMs $CloseTimeoutMs
    if (@($remainingProcessIds).Count -gt 0) {
      if (-not $AllowForceKillExisting.IsPresent) {
        Write-WrapperStatus -Status 'failed' -Phase $script:CurrentPhase -Message 'TradingView did not exit gracefully within the configured timeout.' -Extra @{
          executablePath = $resolvedExecutablePath
          launchMode = $launchMode
          appUserModelId = $resolvedAppUserModelId
          packageFamilyName = $packageFamilyName
          existingProcessIds = $existingProcessIds
          attemptedCloseProcessIds = @($closedProcessIds)
          remainingProcessIds = $remainingProcessIds
          allowForceKillExisting = $false
        }
        throw "TradingView did not exit gracefully within ${CloseTimeoutMs}ms. Re-run the wrapper with -AllowForceKillExisting only if a forceful restart is acceptable."
      }

      $script:CurrentPhase = 'force-kill-existing'
      Write-WrapperStatus -Status 'running' -Phase $script:CurrentPhase -Message 'Force-killing remaining TradingView processes after graceful shutdown timed out.' -Extra @{
        executablePath = $resolvedExecutablePath
        launchMode = $launchMode
        appUserModelId = $resolvedAppUserModelId
        packageFamilyName = $packageFamilyName
        existingProcessIds = $existingProcessIds
        attemptedCloseProcessIds = @($closedProcessIds)
        remainingProcessIds = $remainingProcessIds
      }

      foreach ($remainingProcessId in $remainingProcessIds) {
        try {
          Stop-Process -Id $remainingProcessId -Force -ErrorAction Stop
          $forcedProcessIds.Add([int]$remainingProcessId)
        } catch {
          continue
        }
      }

      $remainingAfterForceKill = Wait-ForProcessExit -ProcessIds $remainingProcessIds -TimeoutMs 4000
      if (@($remainingAfterForceKill).Count -gt 0) {
        Write-WrapperStatus -Status 'failed' -Phase $script:CurrentPhase -Message 'TradingView processes remained alive after force-kill.' -Extra @{
          executablePath = $resolvedExecutablePath
          launchMode = $launchMode
          appUserModelId = $resolvedAppUserModelId
          packageFamilyName = $packageFamilyName
          existingProcessIds = $existingProcessIds
          attemptedCloseProcessIds = @($closedProcessIds)
          forcedProcessIds = @($forcedProcessIds)
          remainingProcessIds = $remainingAfterForceKill
          allowForceKillExisting = $true
        }
        throw "TradingView processes remained alive after force-kill: $($remainingAfterForceKill -join ', ')"
      }
    }
  }

  $script:CurrentPhase = 'remove-stale-devtools'
  $removedDevToolsMarkers = @(Remove-StaleDevToolsActivePortMarkers)
  Write-WrapperStatus -Status 'running' -Phase $script:CurrentPhase -Message 'Removed stale TradingView DevToolsActivePort markers before relaunch.' -Extra @{
    executablePath = $resolvedExecutablePath
    launchMode = $launchMode
    appUserModelId = $resolvedAppUserModelId
    packageFamilyName = $packageFamilyName
    removedDevToolsActivePortPaths = $removedDevToolsMarkers
    closedProcessIds = @($closedProcessIds)
    forcedProcessIds = @($forcedProcessIds)
  }

  $script:CurrentPhase = 'launching'
  Write-WrapperStatus -Status 'running' -Phase $script:CurrentPhase -Message 'Launching TradingView through the automation-ready wrapper.' -Extra @{
    executablePath = $resolvedExecutablePath
    workingDirectory = $workingDirectory
    launchMode = $launchMode
    appUserModelId = $resolvedAppUserModelId
    packageFamilyName = $packageFamilyName
    launchArguments = @($launchArguments)
    removedDevToolsActivePortPaths = $removedDevToolsMarkers
    closedProcessIds = @($closedProcessIds)
    forcedProcessIds = @($forcedProcessIds)
  }

  $startedProcess = $null
  $activationHResult = ''
  $launchedProcessId = 0
  if ($launchMode -eq 'packaged-app-activation') {
    $activationResult = Start-PackagedTradingViewApplication -ResolvedAppUserModelId $resolvedAppUserModelId -LaunchArguments @($launchArguments)
    $launchedProcessId = [int]$activationResult.processId
    $activationHResult = [string]$activationResult.hresult
  } else {
    $startedProcess = Start-Process -FilePath $resolvedExecutablePath -WorkingDirectory $workingDirectory -ArgumentList @($launchArguments) -PassThru
    if ($startedProcess) {
      $launchedProcessId = [int]$startedProcess.Id
    }
  }

  if ($LaunchSettleMs -gt 0) {
    Start-Sleep -Milliseconds $LaunchSettleMs
  }

  $launchedProcessAlive = $false
  if ($launchedProcessId -gt 0) {
    $launchedProcessAlive = $null -ne (Get-Process -Id $launchedProcessId -ErrorAction SilentlyContinue)
  }
  $observedProcessesAfterLaunch = @(Get-TradingViewProcesses)
  $observedProcessIdsAfterLaunch = @($observedProcessesAfterLaunch | ForEach-Object { [int]$_.processId } | Where-Object { $_ -gt 0 })

  if (-not $launchedProcessAlive -and @($observedProcessIdsAfterLaunch).Count -eq 0) {
    Write-WrapperStatus -Status 'failed' -Phase $script:CurrentPhase -Message 'TradingView exited before the wrapper could verify a live launched process.' -Extra @{
      executablePath = $resolvedExecutablePath
      workingDirectory = $workingDirectory
      launchMode = $launchMode
      appUserModelId = $resolvedAppUserModelId
      packageFamilyName = $packageFamilyName
      launchArguments = @($launchArguments)
      launchedProcessId = $launchedProcessId
      launchedProcessAlive = $false
      activationHResult = $activationHResult
      observedProcessIdsAfterLaunch = $observedProcessIdsAfterLaunch
      closedProcessIds = @($closedProcessIds)
      forcedProcessIds = @($forcedProcessIds)
      removedDevToolsActivePortPaths = $removedDevToolsMarkers
      allowForceKillExisting = $AllowForceKillExisting.IsPresent
    }
    throw "TradingView exited before the wrapper could verify a live launched process: $launchedProcessId"
  }

  $script:CurrentPhase = 'launched'
  $result = [ordered]@{
    status = 'launched'
    message = 'TradingView automation wrapper launched TradingView through the resolved automation-ready target.'
    executablePath = $resolvedExecutablePath
    workingDirectory = $workingDirectory
    launchMode = $launchMode
    appUserModelId = $resolvedAppUserModelId
    packageFamilyName = $packageFamilyName
    launchArguments = @($launchArguments)
    launchedProcessId = $launchedProcessId
    launchedProcessAlive = $launchedProcessAlive
    activationHResult = $activationHResult
    observedProcessIdsAfterLaunch = $observedProcessIdsAfterLaunch
    closedProcessIds = @($closedProcessIds)
    forcedProcessIds = @($forcedProcessIds)
    removedDevToolsActivePortPaths = $removedDevToolsMarkers
    allowForceKillExisting = $AllowForceKillExisting.IsPresent
    updatedAt = (Get-Date).ToString('o')
  }

  Write-WrapperStatus -Status 'launched' -Phase $script:CurrentPhase -Message $result.message -Extra @{
    executablePath = $result.executablePath
    workingDirectory = $result.workingDirectory
    launchMode = $result.launchMode
    appUserModelId = $result.appUserModelId
    packageFamilyName = $result.packageFamilyName
    launchArguments = $result.launchArguments
    launchedProcessId = $result.launchedProcessId
    launchedProcessAlive = $result.launchedProcessAlive
    activationHResult = $result.activationHResult
    observedProcessIdsAfterLaunch = $result.observedProcessIdsAfterLaunch
    closedProcessIds = $result.closedProcessIds
    forcedProcessIds = $result.forcedProcessIds
    removedDevToolsActivePortPaths = $result.removedDevToolsActivePortPaths
    allowForceKillExisting = $result.allowForceKillExisting
  }

  $result | ConvertTo-Json -Depth 8
  exit 0
} catch {
  $errorMessage = $_.Exception.Message
  Write-WrapperStatus -Status 'failed' -Phase $script:CurrentPhase -Message $errorMessage -Extra @{
    error = $errorMessage
  }
  Write-Error $errorMessage
  exit 1
}
