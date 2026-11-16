# Run from an attended, unelevated Windows x64 desktop. Does not install tools,
# change release gates, register a runner or retry interrupted computer actions.
[CmdletBinding()]
param(
  [ValidateSet("native", "lifecycle", "privacy", "displays", "provider-workflows", "profiles", "physical-stop", "quality")]
  [string]$Phase = "native",
  [ValidateSet("both", "claude", "codex")]
  [string]$Provider = "both",
  [string]$SuiteDirectory,
  [string]$ClaudeHome,
  [string]$ClaudeBinary,
  [string]$CodexHome,
  [string]$CodexBinary
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repo = Split-Path $PSScriptRoot -Parent
$previousDirectory = Get-Location
try {
  Set-Location $repo
  foreach ($tool in @("git", "node", "bun", "cargo")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is missing. Install the prerequisites described in docs/computer-certification/windows-preview.md."
    }
  }
  node scripts/computer-certification/windowsRunner.ts
  if ($LASTEXITCODE -ne 0) { throw "Use an unlocked, connected, unelevated Windows x64 desktop." }
  $dirty = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Acceptance requires a clean Git checkout containing these changes. Commit the intended source first; this script does not change Git history."
  }
  if (-not $SuiteDirectory) {
    $SuiteDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("f5-windows-acceptance-" + [guid]::NewGuid().ToString("N"))
  }
  $SuiteDirectory = [System.IO.Path]::GetFullPath($SuiteDirectory)
  if (Test-Path $SuiteDirectory) { throw "Choose a new suite directory; previous evidence is never overwritten." }
  $launch = @()
  if ($Phase -eq "profiles") {
    if ($Provider -eq "claude") { throw "Profile isolation requires Codex. Select codex or both." }
    $Provider = "codex"
  }
  if ($Phase -in @("provider-workflows", "profiles", "physical-stop")) {
    foreach ($name in @("claude", "codex")) {
      if ($Provider -ne "both" -and $Provider -ne $name) { continue }
      $homePath = if ($name -eq "claude") { $ClaudeHome } else { $CodexHome }
      $binaryPath = if ($name -eq "claude") { $ClaudeBinary } else { $CodexBinary }
      if (-not $homePath -or -not (Test-Path -LiteralPath $homePath -PathType Container) -or
          -not $binaryPath -or -not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
        throw "Supply -$($name)Home and -$($name)Binary for an authenticated test profile and executable."
      }
      $launch += @("--$name-home", $homePath, "--$name-binary", $binaryPath)
    }
  }
  Write-Host "Keep this Windows session unlocked. Approve only the named test apps when prompted."
  Write-Host "Emergency stop: Ctrl+Alt+Shift+F12. Evidence directory: $SuiteDirectory"
  bun install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
  bun scripts/computer-certification.ts prepare --output $SuiteDirectory --platform win32 --arch x64 --provider $Provider @launch
  if ($LASTEXITCODE -ne 0) { throw "Acceptance preparation failed. Check the Rust/MSVC and Windows SDK prerequisites." }
  $group = "workflows"
  $scenarios = @("windows-helper")
  switch ($Phase) {
    "lifecycle" { $group = "recovery"; $scenarios = @("windows-lifecycle") }
    "privacy" { $group = "protection"; $scenarios = @("capture") }
    "displays" { $group = "protection"; $scenarios = @("displays") }
    "profiles" { $scenarios = @("profile-readiness", "profile-inspection-diagnostic", "profile-isolation") }
    "quality" { $group = "automated"; $scenarios = @("quality", "native-tests") }
    { $_ -in @("provider-workflows", "physical-stop") } {
      $phases = @("discovery", "fixture-workflow", "chromium-workflow", "windows-background", "grant-memory", "session-actions")
      if ($Phase -eq "physical-stop") { $group = "recovery"; $phases = @("main-stop", "renderer-stop", "backend-stop") }
      $scenarios = @()
      foreach ($name in @("claude", "codex")) {
        if ($Provider -ne "both" -and $Provider -ne $name) { continue }
        foreach ($step in $phases) { $scenarios += "$step.$name" }
      }
    }
  }
  try {
    foreach ($scenario in $scenarios) {
      bun scripts/computer-certification.ts run --output $SuiteDirectory --group $group --scenario $scenario --operator-ready
      if ($LASTEXITCODE -ne 0) {
        throw "Acceptance stopped at $scenario. Do not retry input automatically; review its report first."
      }
    }
  } finally {
    bun scripts/computer-certification.ts report --output $SuiteDirectory
    Write-Host "Reports: $SuiteDirectory"
    Write-Host "Share manifest.json, *.result.json and *.raw.json only. Keep launch.json and provider homes private."
    Write-Host "A green subset does not enable preview or establish signed certification."
  }
} finally {
  Set-Location $previousDirectory
}
