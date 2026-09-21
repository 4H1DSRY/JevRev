param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [ValidateSet("auto", "cpu", "cuda")]
    [string]$Device = "auto",
    [int]$Port = 4877,
    [int]$BatchSize = 8,
    [switch]$Background
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = Join-Path $InstallRoot ".venv\Scripts\python.exe"
$model = Join-Path $InstallRoot "models\Qwen3-Reranker-0.6B"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Local environment not found at $python. Run scripts/setup-local.ps1 first."
}
if (-not (Test-Path -LiteralPath (Join-Path $model "model.safetensors"))) {
    throw "Model weights not found at $model. Run scripts/setup-local.ps1 first."
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use."
}

$serverArgs = @(
    "-m", "runtime.server",
    "--model", $model,
    "--device", $Device,
    "--port", $Port,
    "--batch-size", $BatchSize
)

if (-not $Background) {
    Push-Location $repoRoot
    try {
        & $python @serverArgs
    } finally {
        Pop-Location
    }
    exit $LASTEXITCODE
}

$logs = Join-Path $InstallRoot "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stdoutLog = Join-Path $logs "runtime.out.log"
$stderrLog = Join-Path $logs "runtime.err.log"
$pidFile = Join-Path $InstallRoot "runtime.pid"

$process = Start-Process `
    -FilePath $python `
    -ArgumentList $serverArgs `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds(60)
$serverPid = $null
while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
        throw "JevRev local runtime exited during startup. See $stderrLog"
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
    throw "JevRev local runtime did not listen on port $Port within 60 seconds. See $stderrLog"
}

Set-Content -LiteralPath $pidFile -Value $serverPid -Encoding ascii
Write-Host "JevRev local runtime started as PID $serverPid on http://127.0.0.1:$Port"
Write-Host "Logs: $stdoutLog and $stderrLog"
