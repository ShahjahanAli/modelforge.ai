$ErrorActionPreference = "SilentlyContinue"
$requestPath = Join-Path $PSScriptRoot ".mf-stt-request.json"
$config = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$py = [string]$config.pythonBin
$root = (Get-Item (Join-Path $PSScriptRoot "../../..")).FullName
$audio = Join-Path $root ($config.audioRelativePath -replace "/", [IO.Path]::DirectorySeparatorChar)
$script = Join-Path $root "scripts/faster-whisper-transcribe.py"

$line = & $py $script --audio $audio --model ([string]$config.model) --device ([string]$config.device) --compute-type ([string]$config.computeType) --beam-size ([string]$config.beamSize) --best-of ([string]$config.bestOf) --temperature ([string]$config.temperature) --no-speech-threshold ([string]$config.noSpeechThreshold) --no-vad-filter $(if ([string]$config.language) { "--language"; [string]$config.language }) $(if ([string]$config.initialPrompt) { "--initial-prompt"; [string]$config.initialPrompt }) 2>$null | Select-Object -Last 1
Write-Output $line
