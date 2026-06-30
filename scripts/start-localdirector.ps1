param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not installed or not in PATH. $InstallHint"
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "Local Director setup" -ForegroundColor Cyan
Write-Host "Project: $root"

Require-Command -Name "node" -InstallHint "Install Node.js 22 LTS or newer."
Require-Command -Name "npm" -InstallHint "Install Node.js, which includes npm."
Require-Command -Name "docker" -InstallHint "Install and start Docker Desktop."

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example. Please fill AI_API_KEY and admin secrets before real use." -ForegroundColor Yellow
  } else {
    throw ".env is missing and .env.example was not found."
  }
}

if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
  Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
  npm ci
}

Write-Host "Starting PostgreSQL and Redis with Docker..." -ForegroundColor Cyan
docker compose up -d postgres redis

Write-Host "Generating Prisma client..." -ForegroundColor Cyan
npx prisma generate

Write-Host "Applying database migrations..." -ForegroundColor Cyan
npx prisma migrate deploy

Write-Host ""
Write-Host "Setup complete. Start the app in two terminals:" -ForegroundColor Green
Write-Host ""
Write-Host "Terminal 1:" -ForegroundColor Cyan
Write-Host "  cd $root"
Write-Host "  npm run api:dev"
Write-Host ""
Write-Host "Terminal 2:" -ForegroundColor Cyan
Write-Host "  cd $root"
Write-Host "  npm run dev:local"
Write-Host ""
Write-Host "Open:" -ForegroundColor Cyan
Write-Host "  http://localhost:3100/dashboard"
Write-Host "  http://localhost:3100/projects"
