$root = "D:\_Development\X. Project _X\78. ModelForge - LLM Runtime Platform\Development\modelforge.ai"
$audio = Join-Path $root "data/audio/1787493309908-e3e8b5ec-e61a-44d7-ba9b-5e76695a3265-1787493309253-9c2da14a-5a8e-495f-b4b8-8342a6b1207d-Arnob_Call_Record_20260823_trim_0-51200ms.wav"
$argsJson = ConvertTo-Json @(
  "--audio", $audio,
  "--model", "bengaliAI/tugstugi_bengaliai-regional-asr_whisper-medium",
  "--device", "cpu",
  "--compute-type", "int8",
  "--beam-size", "5",
  "--best-of", "5",
  "--temperature", "0",
  "--no-speech-threshold", "0.35",
  "--no-vad-filter",
  "--language", "bn"
)
$line = & (Join-Path $root "scripts/run-faster-whisper.ps1") `
  -PythonBin "C:/Users/admin/AppData/Local/Programs/Python/Python311/python.exe" `
  -ScriptPath (Join-Path $root "scripts/faster-whisper-transcribe.py") `
  -ArgumentsJson $argsJson
Write-Output $line
