# Build only the diagnostic helper in a new temporary directory, then run one
# fresh synthetic workflow. Never modifies the existing checkout or suite.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$SuiteDirectory)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:OS -ne "Windows_NT") { throw "Run on the attended Windows acceptance machine." }
foreach ($tool in @("cargo", "bun")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required." }
}
foreach ($file in @("manifest.json", "launch.json", "fixtures/ComputerControlFixture.exe")) {
  if (-not (Test-Path -LiteralPath (Join-Path $SuiteDirectory $file) -PathType Leaf)) {
    throw "The prepared suite is missing $file."
  }
}
$identityPath = Join-Path $PSScriptRoot "monitor-source-identity.json"
$identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
foreach ($file in $identity.files) {
  if ($file.path -match "(^|[/\\])\.\.([/\\]|$)" -or [IO.Path]::IsPathRooted($file.path)) {
    throw "Invalid source identity path."
  }
  $path = Join-Path $PSScriptRoot $file.path
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) {
    throw "Diagnostic source identity mismatch."
  }
}
$sourceHash = (Get-FileHash -LiteralPath $identityPath -Algorithm SHA256).Hash.ToLowerInvariant()
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("f5-windows-monitor-helper-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "native") -Destination (Join-Path $buildRoot "native") -Recurse
Write-Host "Diagnostic source identity: $sourceHash"
Write-Host "Building only the helper in $buildRoot"
cargo build --locked --release --target x86_64-pc-windows-msvc --target-dir (Join-Path $buildRoot "target") --manifest-path (Join-Path $buildRoot "native/windows/Cargo.toml")
if ($LASTEXITCODE -ne 0) { throw "Diagnostic helper build failed. No workflow was started." }
$helper = Join-Path $buildRoot "target/x86_64-pc-windows-msvc/release/f5-computer-helper.exe"
$hash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
& (Join-Path $PSScriptRoot "Diagnose-WindowsComputer.ps1") -SuiteDirectory $SuiteDirectory -Workflow -DiagnosticHelper $helper -HelperSha256 $hash
exit $LASTEXITCODE
