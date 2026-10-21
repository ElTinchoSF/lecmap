# Mantiene vivo el backend de Lecmap. Si Node termina, lo reinicia.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

while ($true) {
  Write-Host "[Lecmap] Iniciando backend en :3001..."
  & node src/index.js
  $code = $LASTEXITCODE
  Write-Host "[Lecmap] El backend terminó con código $code. Reinicio en 5 s..."
  Start-Sleep -Seconds 5
}
