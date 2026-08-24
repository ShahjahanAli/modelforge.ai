param(
    [Parameter(Mandatory = $true)][string]$PythonBin,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$ArgumentsFile
)

$ErrorActionPreference = "SilentlyContinue"
if (-not (Test-Path -LiteralPath $ArgumentsFile)) {
    Write-Error "ArgumentsFile not found: $ArgumentsFile"
    exit 1
}

$raw = Get-Content -LiteralPath $ArgumentsFile -Raw -Encoding UTF8
$raw = $raw.TrimStart([char]0xFEFF).Trim()
$extra = @($raw | ConvertFrom-Json)
if (-not $extra) {
    $extra = @()
}

$output = & $PythonBin $ScriptPath @extra 2>&1
$line = @($output | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
if (-not $line) {
    Write-Error "faster-whisper produced no JSON stdout"
    exit 1
}
Write-Output $line
exit 0
