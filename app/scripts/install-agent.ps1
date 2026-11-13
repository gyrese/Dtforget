# Installe l'agent DtForget : il demarre tout seul a l'ouverture de session Windows, sans fenetre,
# et relie ce PC (et sa carte graphique) a l'atelier du serveur en ligne.
#   .\scripts\install-agent.ps1            installe et demarre l'agent
#   .\scripts\install-agent.ps1 -Remove    le retire
param([switch]$Remove)

$app = Split-Path $PSScriptRoot -Parent
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'DtForget-agent.vbs'

# arrete un agent deja lance
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'agent\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if ($Remove) {
  if (Test-Path $vbs) { Remove-Item $vbs }
  Write-Host "Agent retire."
  exit
}

if (-not (Test-Path (Join-Path $app '.env'))) {
  Write-Host "Creez d'abord app\.env avec PUBLISH_URL et PUBLISH_TOKEN (modele : app\.env.example)."
  exit 1
}

New-Item -ItemType Directory -Force (Join-Path $app 'data') | Out-Null
$lines = @(
  'Set shell = CreateObject("WScript.Shell")',
  ('shell.CurrentDirectory = "' + $app + '"'),
  'shell.Run "cmd /c node --env-file-if-exists=.env agent.js >> data\agent.log 2>&1", 0, False'
)
Set-Content -Path $vbs -Value $lines -Encoding ASCII
Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
Write-Host "Agent installe et demarre. Journal : app\data\agent.log"
