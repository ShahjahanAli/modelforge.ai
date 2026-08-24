param(
    [Parameter(Mandatory = $true)][string]$PythonBin,
    [Parameter(Mandatory = $true)][string]$AudioRelativePath,
    [Parameter(Mandatory = $true)][string]$Model,
    [string]$Device = "cpu",
    [string]$ComputeType = "int8",
    [int]$BeamSize = 5,
    [int]$BestOf = 5,
    [double]$Temperature = 0,
    [double]$NoSpeechThreshold = 0.35,
    [string]$Language = "",
    [switch]$NoVadFilter,
    [switch]$ConditionOnPreviousText,
    [string]$InitialPrompt = ""
)

$ErrorActionPreference = "SilentlyContinue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

$scriptPath = Join-Path $RepoRoot "scripts/faster-whisper-transcribe.py"
$audioPath = Join-Path $RepoRoot ($AudioRelativePath -replace "/", [IO.Path]::DirectorySeparatorChar)

$whisperArgs = @(
    "--audio", $audioPath,
    "--model", $Model,
    "--device", $Device,
    "--compute-type", $ComputeType,
    "--beam-size", "$BeamSize",
    "--best-of", "$BestOf",
    "--temperature", "$Temperature",
    "--no-speech-threshold", "$NoSpeechThreshold"
)

if ($NoVadFilter.IsPresent) {
    $whisperArgs += "--no-vad-filter"
}
if ($ConditionOnPreviousText.IsPresent) {
    $whisperArgs += "--condition-on-previous-text"
}
if ($Language.Trim()) {
    $whisperArgs += @("--language", $Language.Trim())
}
if ($InitialPrompt.Trim()) {
    $whisperArgs += @("--initial-prompt", $InitialPrompt.Trim())
}

$argumentsJson = ConvertTo-Json $whisperArgs
$wrapper = Join-Path $RepoRoot "scripts/run-faster-whisper.ps1"
& $wrapper -PythonBin $PythonBin -ScriptPath $scriptPath -ArgumentsJson $argumentsJson
