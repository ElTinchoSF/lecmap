# Levanta el backend (si hace falta) y un túnel público de Cloudflare.
# Dejá esta ventana abierta. Copiá la URL https://....trycloudflare.com que
# aparece y pegala en la app: "Cambiar servidor".
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$cloudflared = Join-Path $env:LOCALAPPDATA 'AndroidDev\cloudflared.exe'

try {
  Invoke-RestMethod 'http://127.0.0.1:3001/health' -TimeoutSec 3 | Out-Null
  Write-Host "Backend activo en :3001"
} catch {
  Write-Host "El backend no responde. Iniciando con reinicio automático..."
  $backendScript = Join-Path $root 'backend\start-backend.ps1'
  Start-Process -FilePath "powershell" `
    -ArgumentList "-ExecutionPolicy Bypass -File `"$backendScript`"" `
    -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "Iniciando túnel. La URL aparece en las próximas líneas:"
Write-Host ""
& $cloudflared tunnel --url http://127.0.0.1:3001 --no-autoupdate
