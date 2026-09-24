param(
  [switch]$SkipDocker,
  [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

Require-Command "node"
Require-Command "npm"
if (-not $SkipDocker) {
  Require-Command "docker"
}

if (-not (Test-Path (Join-Path $Root ".env"))) {
  Copy-Item (Join-Path $Root ".env.example") (Join-Path $Root ".env")
}

$AgentEnv = Join-Path $Root "apps\gateway-agent\.env"
if (-not (Test-Path $AgentEnv)) {
  Copy-Item (Join-Path $Root "apps\gateway-agent\.env.example") $AgentEnv
}

Push-Location $Root
try {
  npm ci --omit=dev

  if (-not $SkipDocker) {
    docker compose up -d db
    Start-Sleep -Seconds 5
  }

  npx prisma generate --schema apps/api/prisma/schema.prisma

  if (-not $SkipDocker) {
    npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
    if (-not $SkipSeed) {
      node apps/api/prisma/seed.js
    }
  } else {
    Write-Host "Skipped docker/migrate/seed. Run them manually when DATABASE_URL is reachable."
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Install complete."
Write-Host "Edit .env and apps\gateway-agent\.env for real COM/printer settings, then run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\start-demo.ps1"
