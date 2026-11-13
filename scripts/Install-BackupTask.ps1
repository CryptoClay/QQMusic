param(
    [Parameter(Mandatory)][string]$Config,
    [string]$At = '04:30',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
$python = (Get-Command python -ErrorAction Stop).Source
$job = Join-Path $PSScriptRoot 'backup_job.py'
& $python $job --config $resolvedConfig
if ($LASTEXITCODE -ne 0) { throw 'Invalid backup configuration' }
if (-not $Apply) { Write-Host "Dry run: daily backup task at $At. Pass -Apply to register it."; return }
$arguments = '"' + $job + '" --config "' + $resolvedConfig + '" --run'
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName 'QQMusic encrypted backup' -Action $action -Trigger $trigger -Settings $settings -Description 'Stops Hub/Navidrome during backup and restores previous running state. Protect the passphrase file with your user ACL.'
