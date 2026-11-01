# CI defaults to a disposable Windows runner. Local acceptance is explicit and
# refuses existing installs/shortcuts rather than overwriting the user's setup.
param([switch]$AllowLocalMachine)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'check-installer.mjs'))
if ($AllowLocalMachine) { $arguments += '--allow-local-machine' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Installer acceptance failed ($LASTEXITCODE)" }
