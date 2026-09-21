param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [string]$Model = "",
    [string]$LlamaRoot = "",
    [int]$Port = 4878,
    [int]$ContextSize = 4096,
    [int]$ParallelSlots = 1,
    [int]$GpuLayers = -1,
    [int]$WaitSeconds = 60,
    [switch]$Background
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = Join-Path $InstallRoot "models\Qwen3.5-4B-GGUF\Qwen_Qwen3.5-4B-Q4_K_M.gguf"
}
if ([string]::IsNullOrWhiteSpace($LlamaRoot)) {
    $LlamaRoot = Join-Path $InstallRoot "llama-b9222"
}

$server = Join-Path $LlamaRoot "llama-server.exe"
$pidFile = Join-Path $InstallRoot "semif.pid"
$logs = Join-Path $InstallRoot "logs"
$stdoutLog = Join-Path $logs "semif.out.log"
$stderrLog = Join-Path $logs "semif.err.log"

if (-not (Test-Path -LiteralPath $server)) {
    throw "llama-server.exe not found at $server. See docs/SEMIF_LOCAL.md for the pinned runtime."
}
if (-not (Test-Path -LiteralPath $Model)) {
    throw "SemIf model not found at $Model. Download the pinned GGUF before starting the service."
}
if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}
if ($ContextSize -lt 512) {
    throw "ContextSize must be at least 512."
}
if ($ParallelSlots -lt 1 -or $ParallelSlots -gt 16) {
    throw "ParallelSlots must be between 1 and 16."
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $listener) {
    $existing = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
    if (
        $null -ne $existing -and
        $existing.Name -eq "llama-server.exe" -and
        $existing.CommandLine -like "*$Model*" -and
        $existing.CommandLine -like "*--port $Port*"
    ) {
        Write-Host "SemIf llama.cpp service is already listening on http://127.0.0.1:$Port (PID $($listener.OwningProcess))."
        exit 0
    }
    throw "Port $Port is already in use by PID $($listener.OwningProcess)."
}

New-Item -ItemType Directory -Force -Path $InstallRoot, $logs | Out-Null

$serverArgs = @(
    "-m", $Model,
    "-ngl", $(if ($GpuLayers -lt 0) { "all" } else { [string]$GpuLayers }),
    "-c", [string]$ContextSize,
    "-np", [string]$ParallelSlots,
    "--host", "127.0.0.1",
    "--port", [string]$Port,
    "--jinja",
    "-ctxcp", "0",
    "-cpent", "-1",
    "-cram", "0",
    "--no-cache-idle-slots"
)

if (-not $Background) {
    & $server @serverArgs
    exit $LASTEXITCODE
}

$process = Start-Process `
    -FilePath $server `
    -ArgumentList $serverArgs `
    -WorkingDirectory $LlamaRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$serverPid = $null
while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
        throw "SemIf llama.cpp exited during startup. See $stderrLog"
    }
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $listener) {
        $serverPid = $listener.OwningProcess
        break
    }
    Start-Sleep -Milliseconds 500
}
if ($null -eq $serverPid) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    throw "SemIf llama.cpp did not listen on port $Port within $WaitSeconds seconds. See $stderrLog"
}

Set-Content -LiteralPath $pidFile -Value $serverPid -Encoding ascii
Write-Host "SemIf local service started as PID $serverPid on http://127.0.0.1:$Port"
Write-Host "Model: $Model"
Write-Host "Logs: $stdoutLog and $stderrLog"
