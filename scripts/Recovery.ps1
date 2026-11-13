param(
    [Parameter(Mandatory)][ValidateSet('Backup', 'Restore', 'Verify')][string]$Action,
    [string]$Archive,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousPassphrase = $env:QQM_BACKUP_PASSPHRASE
try {
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
        $dockerArgs += @('--volumes-from', 'homemusic_hub:ro', '-v', 'homemusic_navidrome-data:/source/navidrome:ro',
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
    & docker @dockerArgs homemusic-hub:local /project/scripts/recovery.py @commandArgs
    if ($LASTEXITCODE -ne 0) { throw 'Recovery operation failed' }
} finally {
    $env:QQM_BACKUP_PASSPHRASE = $previousPassphrase
}
