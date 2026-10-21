# Reconecta el puente USB al backend (ejecutar después de reconectar el teléfono
# o de reiniciar la PC). No reinstala la app.
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'

& $adb start-server
& $adb reverse tcp:3001 tcp:3001
& $adb reverse --list

Write-Host ""
Write-Host "Puente listo. En la app: http://127.0.0.1:3001/"
