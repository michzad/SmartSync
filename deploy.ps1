# deploy.ps1 – push kodu do Apps Script i aktualizacja wdrożenia z wersją z Configuration.js
# Uruchom z katalogu projektu (Y:\SmartSync lub c:\Users\zadro\.cursor\projects\y-SmartSync).
# Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass; .\deploy.ps1

$ErrorActionPreference = "Stop"
$DeploymentId = "AKfycbwVdd7hT8C_JH1wTyTDrwBmzRxXfHBRs-aDRzRtqiJQ8xSdBC3TFRHXAguy8G15K8Q"
$ConfigFile = "appsscript\Configuration.js"

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $rootDir) { $rootDir = Get-Location.Path }
Set-Location $rootDir

if (-not (Test-Path -LiteralPath $ConfigFile)) {
  Write-Error "Brak pliku $ConfigFile w $rootDir"
  exit 1
}

$content = Get-Content -Path $ConfigFile -Raw -Encoding UTF8
if ($content -match 'LIBRARY_VERSION\s*=\s*"([^"]+)"') {
  $version = $Matches[1]
} else {
  Write-Error "W Configuration.js nie znaleziono LIBRARY_VERSION."
  exit 1
}

$description = "SmartSync v$version"
Write-Host "Wersja z config: $version -> opis wdrozenia: $description" -ForegroundColor Cyan

Write-Host "`nclasp push -f ..." -ForegroundColor Yellow
& npx clasp push -f
if ($LASTEXITCODE -ne 0) {
  Write-Error "clasp push zakonczyl sie kodem $LASTEXITCODE"
  exit $LASTEXITCODE
}

Write-Host "`nclasp create-deployment -i $DeploymentId --description `"$description`" ..." -ForegroundColor Yellow
& npx clasp create-deployment -i $DeploymentId --description $description
if ($LASTEXITCODE -ne 0) {
  Write-Error "clasp create-deployment zakonczyl sie kodem $LASTEXITCODE"
  exit $LASTEXITCODE
}

Write-Host "`nGotowe. Wdrozenie zaktualizowane: $description" -ForegroundColor Green
