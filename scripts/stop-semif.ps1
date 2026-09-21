param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [int]$Port = 4878,
    [string]$Model = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = Join-Path $InstallRoot "models\Qwen3.5-4B-GGUF\Qwen_Qwen3.5-4B-Q4_K_M.gguf"
}

$pidFile = Join-Path $InstallRoot "semif.pid"
$targetPid = $null
if (Test-Path -LiteralPath $pidFile) {
    $targetPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
}

if ($null -eq $targetPid) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $listener) {
        $targetPid = $listener.OwningProcess
    }
}

if ($null -eq $targetPid) {
    Write-Host "SemIf local service is not running."
    exit 0
}

$processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $targetPid) -ErrorAction SilentlyContinue
if ($null -eq $processInfo) {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    Write-Host "Removed stale SemIf PID file."
    exit 0
}

$commandLine = [string]$processInfo.CommandLine
if (
    $processInfo.Name -ne "llama-server.exe" -or
    $commandLine -notlike "*llama-server.exe*" -or
    $commandLine -notlike "*$Model*" -or
    $commandLine -notlike "*--port $Port*"
) {
    throw "PID $targetPid is not the expected SemIf llama.cpp process; refusing to stop it."
}

Stop-Process -Id $targetPid
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
Write-Host "Stopped SemIf local service (PID $targetPid)."
