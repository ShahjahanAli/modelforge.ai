param(
    [Parameter(Mandatory = $true)][string]$PythonBin,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string]$ArgumentsJson = "",
    [string]$ArgumentsFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

if ($ArgumentsFile) {
    if (-not (Test-Path -LiteralPath $ArgumentsFile)) {
        Write-Error "ArgumentsFile not found: $ArgumentsFile"
        exit 1
    }
    $ArgumentsJson = Get-Content -LiteralPath $ArgumentsFile -Raw -Encoding UTF8
}

if (-not $ArgumentsJson.Trim()) {
    Write-Error "ArgumentsJson or ArgumentsFile is required"
    exit 1
}

$extra = @($ArgumentsJson | ConvertFrom-Json)
if (-not $extra) {
    $extra = @()
}

# Node.js on Windows attaches direct Python children to a job object that truncates
# Whisper output on fine-tuned Bengali models (~600 chars vs ~1600). Spawning via
# PowerShell yields the full transcript (same as an interactive shell).
$output = & $PythonBin $ScriptPath @extra 2>&1
$line = @($output | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
if (-not $line) {
    Write-Error "faster-whisper produced no JSON stdout"
    exit 1
}
Write-Output $line
exit 0
