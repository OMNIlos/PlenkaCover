param(
  [switch]$PrintTest
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $Root
try {
  $Args = @("tools/hardware-preflight.mjs")
  if ($PrintTest) {
    $Args += "--print-test"
  }
  node @Args
} finally {
  Pop-Location
}
