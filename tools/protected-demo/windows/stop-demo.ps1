param(
  [switch]$StopDatabase
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunDir = Join-Path $Root ".run"

foreach ($Name in @("frontend", "agent", "api")) {
  $PidFile = Join-Path $RunDir "$Name.pid"
  if (-not (Test-Path $PidFile)) {
    continue
  }

  $PidValue = [int](Get-Content $PidFile)
  $Process = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
  if ($Process) {
    Stop-Process -Id $PidValue -Force
    Write-Host "Stopped $Name (pid $PidValue)."
  }
  Remove-Item $PidFile -Force
}

if ($StopDatabase) {
  Push-Location $Root
  try {
    docker compose down
  } finally {
    Pop-Location
  }
}
