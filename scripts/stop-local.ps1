param(
    [string]$InstallRoot = "D:\SpecJevLocal"
)

$ErrorActionPreference = "Stop"
$pidFile = Join-Path $InstallRoot "runtime.pid"
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "JevRev local runtime is not recorded as running."
    exit 0
}

$runtimePid = [int](Get-Content -LiteralPath $pidFile -Raw)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $runtimePid" -ErrorAction SilentlyContinue
if ($null -eq $processInfo) {
    Remove-Item -LiteralPath $pidFile
    Write-Host "Removed stale runtime PID file."
    exit 0
}

$expectedModel = Join-Path $InstallRoot "models\Qwen3-Reranker-0.6B"
if (
    $processInfo.Name -ne "python.exe" -or
    $processInfo.CommandLine -notlike "*-m runtime.server*" -or
    $processInfo.CommandLine -notlike "*$expectedModel*"
) {
    throw "PID $runtimePid is not the JevRev Python runtime; refusing to stop it."
}

Stop-Process -Id $runtimePid
Remove-Item -LiteralPath $pidFile
Write-Host "Stopped JevRev local runtime (PID $runtimePid)."
