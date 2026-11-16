#requires -Version 7.0
<#
.SYNOPSIS
Build and test the native QQMusic Android client. Never publishes an update.
.EXAMPLE
pwsh -File scripts/release-android.ps1 -Configuration Debug
.EXAMPLE
pwsh -File scripts/release-android.ps1 -Configuration Release -VersionName 0.1.0 -VersionCode 1
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug','Release')][string]$Configuration = 'Debug',
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$VersionName = '0.1.0',
    [ValidateRange(1,2100000000)][int]$VersionCode = 1,
    [string]$AndroidPath,
    [string]$JavaHome,
    [string]$AndroidSdk,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $AndroidPath) { $AndroidPath = Join-Path $root 'android' }
if (-not $OutputPath) { $OutputPath = Join-Path $root 'reports/android' }
$AndroidPath = [IO.Path]::GetFullPath($AndroidPath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath (Join-Path $AndroidPath 'app/build.gradle.kts'))) {
    throw "Android sources not found at $AndroidPath. Update main and check android/README.md."
}
if ($JavaHome) { $env:JAVA_HOME = [IO.Path]::GetFullPath($JavaHome) }
if ($AndroidSdk) { $env:ANDROID_HOME = [IO.Path]::GetFullPath($AndroidSdk); $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME }
if ($Configuration -eq 'Release' -and -not (Test-Path -LiteralPath (Join-Path $AndroidPath 'keystore.properties'))) {
    throw 'Release signing is not configured. See android/README.md; use Debug for a test APK.'
}
$wrapper = if ($IsWindows) { Join-Path $AndroidPath 'gradlew.bat' } else { Join-Path $AndroidPath 'gradlew' }
Push-Location $AndroidPath
try {
    $arguments = @("test${Configuration}UnitTest", "lint$Configuration", "assemble$Configuration",
        "-PqqmVersionCode=$VersionCode", "-PqqmVersionName=$VersionName", '--console', 'plain')
    if ($IsWindows) { & $wrapper @arguments } else { & bash $wrapper @arguments }
    if ($LASTEXITCODE -ne 0) { throw "Android checks failed ($LASTEXITCODE). No artifacts published." }
} finally { Pop-Location }
$variant = $Configuration.ToLowerInvariant()
$dir = Join-Path $AndroidPath "app/build/outputs/apk/$variant"
$metadata = Get-Content -Raw -LiteralPath (Join-Path $dir 'output-metadata.json') | ConvertFrom-Json
$expectedPackage = if ($Configuration -eq 'Debug') { 'ru.qqmusic.app.debug' } else { 'ru.qqmusic.app' }
$expectedVersion = if ($Configuration -eq 'Debug') { "$VersionName-debug" } else { $VersionName }
$elements = @($metadata.elements)
if ($metadata.applicationId -ne $expectedPackage -or $elements.Count -ne 1 -or
    $metadata.variantName -ne $variant -or $metadata.artifactType.type -ne 'APK' -or
    $elements[0].type -ne 'SINGLE' -or @($elements[0].filters).Count -ne 0 -or $elements[0].versionName -ne $expectedVersion -or
    $elements[0].versionCode -ne $VersionCode -or $elements[0].outputFile -ne [IO.Path]::GetFileName($elements[0].outputFile)) {
    throw 'Unexpected APK build metadata.'
}
$apk = Join-Path $dir $elements[0].outputFile
if (-not (Test-Path -LiteralPath $apk)) { throw 'APK missing after build.' }
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
$name = "QQMusic-$VersionName-$VersionCode-$variant.apk"
$target = Join-Path $OutputPath $name
if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) {
    throw "An APK with this version already exists with different bytes. Increase VersionCode or choose another OutputPath."
}
Copy-Item -LiteralPath $apk -Destination $target -Force
[IO.File]::WriteAllText((Join-Path $OutputPath "$name.sha256"), "$hash  $name`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built and tested: $target"
Write-Host "SHA256: $hash"
Write-Host 'No server files or latest.json were changed.'
