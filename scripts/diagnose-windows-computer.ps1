# Diagnostics for an already prepared acceptance checkout. No builds, installs,
# Git mutations or acceptance evidence changes. Input requires -Workflow.
[CmdletBinding()]
param(
  [string]$Checkout,
  [string]$SuiteDirectory,
  [switch]$Workflow,
  [string]$DiagnosticHelper,
  [ValidatePattern("^[a-fA-F0-9]{64}$")]
  [string]$HelperSha256
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:OS -ne "Windows_NT") { throw "Run this diagnostic on the Windows acceptance machine." }
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "Bun is required." }
if ($DiagnosticHelper -and -not $Workflow) { throw "-DiagnosticHelper requires -Workflow." }
$standalone = Join-Path $PSScriptRoot $(if ($Workflow) { "Diagnose-WindowsWorkflow.mjs" } else { "Diagnose-WindowsComputer.ts" })
$inCheckout = Join-Path $PSScriptRoot $(if ($Workflow) { "../apps/desktop/src/computer/rehearseHelperWindows.ts" } else { "../apps/desktop/src/computer/rehearsalWindowsDiagnostics.ts" })
$diagnostic = if (Test-Path -LiteralPath $standalone -PathType Leaf) { $standalone } else { $inCheckout }
if (-not (Test-Path -LiteralPath $diagnostic -PathType Leaf)) { throw "Extract both diagnostic files together." }
if ($SuiteDirectory -and -not $Checkout) {
  # Resolve only the checkout path from local launch metadata. Provider homes,
  # executable settings and credentials are neither used nor printed.
  $launchPath = Join-Path $SuiteDirectory "launch.json"
  if (Test-Path -LiteralPath $launchPath -PathType Leaf) {
    try {
      $saved = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
      if ($saved.target.repo -is [string] -and
          (Test-Path -LiteralPath (Join-Path $saved.target.repo "apps/desktop/dist-native/win-x64/f5-computer-helper.exe"))) {
        $Checkout = $saved.target.repo
      }
    } catch { }
  }
}
if (-not $Checkout) {
  $locations = @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent), (Get-Location).Path)
  $candidates = @(
    foreach ($location in $locations) {
      if (Test-Path -LiteralPath (Join-Path $location "apps/desktop/dist-native/win-x64/f5-computer-helper.exe")) { $location }
      foreach ($folder in @(Get-ChildItem -LiteralPath $location -Directory -Filter "f5-windows-preview-*" -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $folder.FullName "apps/desktop/dist-native/win-x64/f5-computer-helper.exe")) { $folder.FullName }
      }
    }
  )
  $candidates = @($candidates | ForEach-Object { [System.IO.Path]::GetFullPath($_) } | Sort-Object -Unique)
  if ($candidates.Count -ne 1) { throw "Pass -Checkout with the existing f5-windows-preview folder path." }
  $Checkout = $candidates[0]
}
if (-not $SuiteDirectory) {
  $failedSuites = @(
    foreach ($folder in @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter "f5-windows-acceptance-*")) {
      $report = Join-Path $folder.FullName "windows-helper.001.raw.json"
      if ((Test-Path -LiteralPath $report -PathType Leaf) -and
          (Test-Path -LiteralPath (Join-Path $folder.FullName "manifest.json") -PathType Leaf)) {
        try {
          if ((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).state -eq "failed") { $folder.FullName }
        } catch { }
      }
    }
  )
  if ($failedSuites.Count -ne 1) { throw "Pass -SuiteDirectory with the failed suite directory path printed by acceptance." }
  $SuiteDirectory = $failedSuites[0]
}
if ($Workflow) {
  $manifest = Get-Content -LiteralPath (Join-Path $SuiteDirectory "manifest.json") -Raw | ConvertFrom-Json
  $suiteHash = $manifest.identity.files.helper
  if ($suiteHash -notmatch "^[a-fA-F0-9]{64}$") { throw "The suite has no valid helper identity." }
  $selectedHash = if ($HelperSha256) { $HelperSha256 } else { $suiteHash }
  $helperPath = if ($DiagnosticHelper) {
    (Resolve-Path -LiteralPath $DiagnosticHelper).Path
  } else { Join-Path $Checkout "apps/desktop/dist-native/win-x64/f5-computer-helper.exe" }
  $actualHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $selectedHash) {
    @{ state = "failed"; stage = "diagnostic-setup"; failure = @{ code = "helper-identity-mismatch" };
       identity = @{ suiteHelperSha256 = $suiteHash; selectedHelperSha256 = $selectedHash; currentHelperSha256 = $actualHash } } | ConvertTo-Json -Depth 4
    exit 1
  }
  $fixtures = Join-Path $SuiteDirectory "fixtures"
  if (-not (Test-Path -LiteralPath (Join-Path $fixtures "ComputerControlFixture.exe") -PathType Leaf)) {
    throw "The prepared synthetic fixture is missing."
  }
  Write-Host "Fresh synthetic native workflow: sends input to owned fixtures and takes scoped screenshots."
  Write-Host "Keep this session unlocked and input idle. Emergency stop: Ctrl+Alt+Shift+F12."
  $output = Join-Path ([System.IO.Path]::GetTempPath()) ("f5-windows-workflow-diagnostic-" + [guid]::NewGuid().ToString("N") + ".json")
  $environmentKeys = @("F5_COMPUTER_WINDOWS_REHEARSAL", "F5_COMPUTER_WINDOWS_WORKFLOW_DIAGNOSTIC", "F5_COMPUTER_CERTIFICATION_ADMISSION")
  $savedEnvironment = @{}
  foreach ($key in $environmentKeys) { $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }
  try {
    $env:F5_COMPUTER_WINDOWS_REHEARSAL = "1"
    $env:F5_COMPUTER_WINDOWS_WORKFLOW_DIAGNOSTIC = "1"
    Remove-Item Env:F5_COMPUTER_CERTIFICATION_ADMISSION -ErrorAction SilentlyContinue
    bun $diagnostic --helper $helperPath --fixture-bin-dir $fixtures --output $output
    $code = $LASTEXITCODE
  } finally {
    foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], "Process") }
  }
  $report = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
  $afterHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $report | Add-Member -Force -NotePropertyName diagnosticOnly -NotePropertyValue $true
  $report | Add-Member -NotePropertyName identity -NotePropertyValue @{
    suiteHelperSha256 = $suiteHash; selectedHelperSha256 = $selectedHash;
    currentHelperSha256 = $actualHash; helperUnchanged = ($afterHash -eq $actualHash);
    matchesSuiteHelper = ($suiteHash -eq $actualHash)
  }
  if ($afterHash -ne $actualHash) { $report.state = "failed"; $code = 1 }
  $report | ConvertTo-Json -Depth 12
  Write-Host "Diagnostic report: $output"
  Write-Host "No acceptance evidence was updated. Do not retry automatically after failure."
  exit $code
}
Write-Host "Inspection-only diagnostic: synthetic fixtures and accessibility inspection. Keep input idle."
$selection = @()
if ($HelperSha256) {
  Write-Host "Using the explicitly selected helper hash for diagnostics only. Acceptance evidence is unchanged."
  $selection = @("--helper-sha256", $HelperSha256)
}
bun $diagnostic --checkout $Checkout --suite $SuiteDirectory @selection
if ($LASTEXITCODE -ne 0) {
  Write-Host "Diagnostic finished with a failure. Paste the JSON above; do not rerun the input workflow yet."
  exit 1
}
