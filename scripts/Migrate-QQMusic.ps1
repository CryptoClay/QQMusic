param([switch]$Apply)
# Inspect/adopt the old volumes rather than copying or renaming databases under a running server.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $envPath = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { throw 'Copy .env.example to .env first.' }
    $ids = @(& docker ps -aq --filter 'label=com.docker.compose.project=homemusic')
    if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable.' }
    if (-not $ids.Count) { Write-Host 'No legacy stack found. Use docker compose up -d --build.'; return }
    $legacy = @(& docker inspect @ids | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the legacy stack.' }
    $newRunning = @(& docker ps -q --filter 'label=com.docker.compose.project=qqmusic')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect QQMusic.' }
    if ($newRunning.Count) { throw 'QQMusic is already running. Do not attach a second stack to the same databases.' }
    $bindings = [ordered]@{}
    $mounts = @(
        @('hub', '/data', 'QQMUSIC_HUB_VOLUME'),
        @('navidrome', '/data', 'QQMUSIC_NAVIDROME_VOLUME'),
        @('embedder', '/data', 'QQMUSIC_EMBEDDER_VOLUME'),
        @('embedder', '/models', 'QQMUSIC_MODELS_VOLUME')
    )
    foreach ($spec in $mounts) {
        $service = @($legacy | Where-Object { $_.Config.Labels.'com.docker.compose.service' -eq $spec[0] })
        if ($service.Count -gt 1) { throw "Ambiguous legacy service: $($spec[0])" }
        if (-not $service.Count) {
            if ($spec[0] -ne 'embedder') { throw "Missing legacy service: $($spec[0])" }
            continue
        }
        $mount = @($service[0].Mounts | Where-Object { $_.Destination -eq $spec[1] -and $_.Type -eq 'volume' })
        if ($mount.Count -ne 1 -or -not $mount[0].Name) { throw "Expected a named volume for $($spec[0]):$($spec[1])" }
        $bindings[$spec[2]] = $mount[0].Name
    }
    $content = [IO.File]::ReadAllText($envPath)
    $profiles = @()
    if ($content -match '(?m)^COMPOSE_PROFILES=([^\r\n]*)') { $profiles += $Matches[1].Trim('"', "'").Split(',') }
    foreach ($container in $legacy) {
        if (-not $container.State.Running) { continue }
        switch ($container.Config.Labels.'com.docker.compose.service') {
            'embedder' { $profiles += 'recommendations' }
            'tunnel' { $profiles += 'gateway' }
        }
    }
    if ($profiles.Count) { $bindings['COMPOSE_PROFILES'] = ($profiles | Where-Object { $_ } | Sort-Object -Unique) -join ',' }
    if ($content -notmatch '(?m)^VPS_USER=') { $bindings['VPS_USER'] = 'homemusic-tunnel' }
    Write-Host 'QQMusic will reuse these data volumes (no database or media copy):'
    foreach ($item in $bindings.GetEnumerator()) {
        Write-Host "  $($item.Key)=$($item.Value)"
        $line = "$($item.Key)=$($item.Value)"
        $pattern = '(?m)^' + [regex]::Escape($item.Key) + '=[^\r\n]*'
        if ($content -match $pattern) { $content = [regex]::Replace($content, $pattern, $line) }
        else { $content = $content.TrimEnd() + "`n$line`n" }
    }
    if (-not $Apply) { Write-Host 'Inspection only. Run again with -Apply to build, stop the old stack and start QQMusic.'; return }
    $backupDir = Join-Path $projectRoot '.agent-work'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $backupDir ('.env.before-qqmusic-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')))
    [IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
    $config = & docker compose config --format json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $config.name -ne 'qqmusic') { throw 'Invalid Compose configuration or COMPOSE_PROJECT_NAME override.' }
    & docker compose build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. The old stack is still running.' }
    $running = @($legacy | Where-Object { $_.State.Running } | ForEach-Object { $_.Id })
    if ($running.Count) {
        & docker stop --time 60 @running
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the old stack. QQMusic was not started.' }
    }
    & docker compose up -d --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'QQMusic did not become ready. Inspect docker compose logs. Old containers and volumes are preserved; see docs/renaming.md for rollback.'
        throw 'Migration requires attention.'
    }
    Write-Host 'QQMusic is ready: http://localhost:8081. Old stopped containers and data volumes were preserved.'
} finally { Pop-Location }
