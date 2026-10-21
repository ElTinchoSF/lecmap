# Compila el APK debug con el toolchain portátil instalado en %LOCALAPPDATA%\AndroidDev.
$ErrorActionPreference = 'Stop'

$dev = Join-Path $env:LOCALAPPDATA 'AndroidDev'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:JAVA_HOME = Join-Path $dev 'jdk'
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$gradle = Join-Path $dev 'gradle-8.9\bin\gradle.bat'
& $gradle assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk'
$copy = Join-Path $PSScriptRoot 'Lecmap-debug.apk'
Copy-Item -Force $apk $copy

Write-Host ""
Write-Host "APK: $apk"
Write-Host "Copia lista para instalar: $copy"
