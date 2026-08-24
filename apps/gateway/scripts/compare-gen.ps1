$genLine = & (Join-Path $PSScriptRoot "debug-generated.ps1") | Select-Object -Last 1
$genLen = ($genLine | ConvertFrom-Json).text.Length
$freshOut = & (Join-Path $PSScriptRoot "test-asr-fresh.ps1") 2>&1 | Out-String
$freshLen = [regex]::Match($freshOut, "len=(\d+)").Groups[1].Value
Write-Host "pure-PS generated=$genLen fresh=$freshLen"
