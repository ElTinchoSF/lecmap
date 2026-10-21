# Instala el APK en un teléfono conectado por USB con depuración activada.
# Además crea un puente USB (adb reverse) para que el teléfono llegue al backend
# en http://127.0.0.1:3001/ sin depender del Wi-Fi ni del firewall.
$ErrorActionPreference = 'Stop'

$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$apk = Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk'

if (-not (Test-Path $apk)) {
  throw "No existe el APK. Ejecutá primero .\build-apk.ps1"
}

& $adb devices
& $adb install -r $apk
& $adb reverse tcp:3001 tcp:3001

Write-Host ""
Write-Host "Listo. En la app tocá 'Cambiar servidor' y poné: http://127.0.0.1:3001/"
Write-Host "El puente USB queda activo mientras el teléfono esté conectado."
