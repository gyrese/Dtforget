# Installe l'agent DtForget : il demarre tout seul a l'ouverture de session Windows, sans fenetre,
# et relie ce PC (et sa carte graphique) a l'atelier du serveur en ligne.
#   .\scripts\install-agent.ps1 -Url https://dtforget.mondomaine.fr -Token xxxx   regle, installe et demarre
#   .\scripts\install-agent.ps1                                                   reinstalle avec les reglages existants
#   .\scripts\install-agent.ps1 -Remove                                           le retire
param([string]$Url, [string]$Token, [switch]$Remove)

$app = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $app '.env'
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

if ($Url -and $Token) {
  # garde les autres reglages de app\.env, remplace l'adresse et le jeton
  $keep = @()
  if (Test-Path $envFile) { $keep = @(Get-Content $envFile | Where-Object { $_ -notmatch '^(PUBLISH_URL|PUBLISH_TOKEN)=' }) }
  Set-Content -Path $envFile -Value ($keep + "PUBLISH_URL=$Url" + "PUBLISH_TOKEN=$Token") -Encoding ASCII
}
if (-not (Test-Path $envFile)) {
  Write-Host "Indiquez le serveur : .\scripts\install-agent.ps1 -Url https://... -Token ..."
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
