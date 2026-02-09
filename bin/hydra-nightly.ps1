<#
.SYNOPSIS
    Hydra Nightly Runner — PowerShell launcher for autonomous overnight work.

.DESCRIPTION
    Launches the Hydra nightly runner from the SideQuest project directory.
    Designed for Windows Task Scheduler or manual invocation.

    The runner:
    - Processes queued tasks on isolated nightly/* branches
    - Manages Claude → Codex 5.3 budget escalation
    - Generates a morning report for review
    - Never touches dev/staging/main

.EXAMPLE
    # Manual run
    .\bin\hydra-nightly.ps1

    # With overrides
    .\bin\hydra-nightly.ps1 -MaxTasks 2 -Project "E:\Dev\SideQuest"

    # Task Scheduler (create via taskschd.msc):
    #   Program: pwsh.exe
    #   Arguments: -NoProfile -ExecutionPolicy Bypass -File "E:\Dev\Hydra\bin\hydra-nightly.ps1"
    #   Start in: E:\Dev\SideQuest
    #   Trigger: Daily at 01:00
#>

param(
    [string]$Project = "E:\Dev\SideQuest",
    [int]$MaxTasks = 0,
    [float]$MaxHours = 0,
    [int]$HardLimit = 0,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Paths
$HydraRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NightlyScript = Join-Path $HydraRoot "lib\hydra-nightly.mjs"
$LogDir = Join-Path $Project "docs\coordination\nightly"
$DateStr = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "nightly-console-$DateStr.log"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Build args
$NodeArgs = @($NightlyScript, "project=$Project")

if ($MaxTasks -gt 0)  { $NodeArgs += "max-tasks=$MaxTasks" }
if ($MaxHours -gt 0)  { $NodeArgs += "max-hours=$MaxHours" }
if ($HardLimit -gt 0) { $NodeArgs += "hard-limit=$HardLimit" }

Write-Host ""
Write-Host "=== Hydra Nightly Runner ===" -ForegroundColor Cyan
Write-Host "  Project:   $Project"
Write-Host "  Script:    $NightlyScript"
Write-Host "  Log:       $LogFile"
Write-Host "  Date:      $DateStr"
Write-Host "  Args:      $($NodeArgs -join ' ')"
Write-Host ""

if ($DryRun) {
    Write-Host "[DRY RUN] Would execute: node $($NodeArgs -join ' ')" -ForegroundColor Yellow
    exit 0
}

# Change to project directory
Push-Location $Project

try {
    # Run the nightly script, tee output to log file
    & node @NodeArgs 2>&1 | Tee-Object -FilePath $LogFile -Append

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "Nightly runner exited with code $exitCode" -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Nightly run complete. Review with: npm run hydra:nightly:review" -ForegroundColor Green
    }
}
catch {
    Write-Host "Fatal error: $_" -ForegroundColor Red
    $_ | Out-File -Append $LogFile
}
finally {
    Pop-Location
}
