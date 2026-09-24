param(
  [switch]$SkipDocker,
  [switch]$SkipAgent,
  [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RunDir = Join-Path $Root ".run"
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

function Start-ManagedProcess($Name, $FilePath, [string[]]$Arguments, $WorkingDirectory) {
  $PidFile = Join-Path $RunDir "$Name.pid"
  if (Test-Path $PidFile) {
    $ExistingPid = [int](Get-Content $PidFile)
    $Existing = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
    if ($Existing) {
      Write-Host "$Name already running (pid $ExistingPid)."
      return
    }
  }

  $Out = Join-Path $LogDir "$Name.out.log"
  $Err = Join-Path $LogDir "$Name.err.log"
  $Process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $Out `
    -RedirectStandardError $Err `
    -PassThru
  Set-Content -Path $PidFile -Value $Process.Id
  Write-Host "Started $Name (pid $($Process.Id)). Logs: logs\$Name.out.log / logs\$Name.err.log"
}

Push-Location $Root
try {
  if (-not $SkipDocker) {
    docker compose up -d db
  }

  Start-ManagedProcess "api" "node" @("apps/api/dist/main.js") $Root

  if (-not $SkipAgent) {
    Start-ManagedProcess "agent" "node" @("dist/main.js") (Join-Path $Root "apps\gateway-agent")
  }

  if ((-not $SkipFrontend) -and (Test-Path (Join-Path $Root "frontend\index.html"))) {
    Start-ManagedProcess "frontend" "node" @("tools/static-server.mjs") $Root
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "API:      http://localhost:3000/api"
Write-Host "Swagger:  http://localhost:3000/api/docs"
if (Test-Path (Join-Path $Root "frontend\index.html")) {
  Write-Host "Frontend: http://localhost:5173"
} else {
  Write-Host "Frontend dist is not included in this package."
}
