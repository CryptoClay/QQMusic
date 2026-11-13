param(
    [Parameter(Mandatory)][ValidateSet('Backup', 'Restore', 'Verify')][string]$Action,
    [string]$Archive,
    [string]$Destination,
    [string]$HubContainer,
    [string]$NavidromeContainer,
    [string]$Image
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousPassphrase = $env:QQM_BACKUP_PASSPHRASE
function Resolve-RunningContainer([string]$Explicit, [string[]]$Candidates) {
    if ($Explicit) { $Candidates = @($Explicit) }
    $found = @($Candidates | Where-Object { (& docker inspect --format '{{.State.Running}}' $_ 2>$null) -eq 'true' })
    if ($found.Count -ne 1) { throw 'Expected exactly one running server. Supply -HubContainer / -NavidromeContainer when using custom names.' }
    return $found[0]
}
try {
    if (-not $Image) {
        foreach ($candidate in @('qqmusic-hub:local', 'homemusic-hub:local')) {
            & docker image inspect $candidate *> $null
            if ($LASTEXITCODE -eq 0) { $Image = $candidate; break }
        }
        if (-not $Image) { throw 'Build the Hub image first or pass -Image.' }
    }
    if ($Action -ne 'Verify' -and -not $env:QQM_BACKUP_PASSPHRASE) {
        $securePassphrase = Read-Host 'Пароль резервной копии (минимум 16 символов)' -AsSecureString
        $passphrasePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassphrase)
        try { $env:QQM_BACKUP_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passphrasePointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passphrasePointer) }
    }
    $dockerArgs = @('run', '--rm', '--network', 'none', '--entrypoint', 'python',
        '-v', "${projectRoot}:/project:ro")
    $commandArgs = @()
    if ($Action -eq 'Backup') {
        if (-not $Archive) { throw '-Archive is required' }
        $archiveFullPath = [IO.Path]::GetFullPath($Archive)
        if (Test-Path -LiteralPath $archiveFullPath) { throw 'Archive already exists' }
        $archiveParent = Split-Path -Parent $archiveFullPath
        New-Item -ItemType Directory -Force -Path $archiveParent | Out-Null
        $archiveName = Split-Path -Leaf $archiveFullPath
        $HubContainer = Resolve-RunningContainer $HubContainer @('qqmusic_hub', 'homemusic_hub')
        $NavidromeContainer = Resolve-RunningContainer $NavidromeContainer @('qqmusic_navidrome', 'homemusic_navidrome')
        $ndMounts = & docker inspect --format '{{json .Mounts}}' $NavidromeContainer | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Navidrome mounts.' }
        $ndData = @($ndMounts | Where-Object { $_.Destination -eq '/data' -and $_.Type -eq 'volume' })
        if ($ndData.Count -ne 1 -or -not $ndData[0].Name) { throw 'Expected a named Navidrome data volume.' }
        $dockerArgs += @('--volumes-from', "${HubContainer}:ro", '-v', "$($ndData[0].Name):/source/navidrome:ro",
            '-v', "${archiveParent}:/output", '-e', 'QQM_BACKUP_PASSPHRASE')
        $commandArgs = @('backup', '--hub-data', '/data', '--navidrome-data', '/source/navidrome',
            '--music-root', '/music', '--env-file', '/project/.env', '--config', '/project/config.yaml',
            '--nd-config', '/project/navidrome/navidrome.toml', '--output', "/output/$archiveName")
    } else {
        if (-not $Destination) { throw '-Destination is required' }
        $destinationFullPath = [IO.Path]::GetFullPath($Destination)
        if ($Action -eq 'Restore') {
            if (-not $Archive) { throw '-Archive is required' }
            if (Test-Path -LiteralPath $destinationFullPath) { throw 'Destination must not exist' }
            $archiveFullPath = (Resolve-Path -LiteralPath $Archive).Path
            $destinationParent = Split-Path -Parent $destinationFullPath
            New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
            $destinationName = Split-Path -Leaf $destinationFullPath
            $dockerArgs += @('-v', "${archiveFullPath}:/input.qqm:ro", '-v', "${destinationParent}:/output", '-e', 'QQM_BACKUP_PASSPHRASE')
            $commandArgs = @('restore', '--archive', '/input.qqm', '--destination', "/output/$destinationName")
        } else {
            $destinationFullPath = (Resolve-Path -LiteralPath $Destination).Path
            $dockerArgs += @('-v', "${destinationFullPath}:/restored:ro")
            $commandArgs = @('verify', '--destination', '/restored')
        }
    }
    & docker @dockerArgs $Image /project/scripts/recovery.py @commandArgs
    if ($LASTEXITCODE -ne 0) { throw 'Recovery operation failed' }
} finally {
    $env:QQM_BACKUP_PASSPHRASE = $previousPassphrase
}
