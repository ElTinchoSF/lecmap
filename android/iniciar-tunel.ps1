# Levanta el backend (si hace falta) y el túnel nombrado de Cloudflare.
# La URL pública estable es https://api.lecmap.app
# Dejá esta ventana abierta.
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
Write-Host "Iniciando túnel nombrado 'lecmap'..."
Write-Host "API pública: https://api.lecmap.app"
Write-Host ""
& $cloudflared tunnel run lecmap --no-autoupdate
