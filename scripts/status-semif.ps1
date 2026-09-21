param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [int]$Port = 4878
)

$ErrorActionPreference = "Stop"
$pidFile = Join-Path $InstallRoot "semif.pid"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $listener) {
    Write-Output "stopped"
    exit 1
}

$processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $listener.OwningProcess) -ErrorAction SilentlyContinue
$health = $null
try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 5
} catch {
    $health = $null
}

[pscustomobject]@{
    status = if ($null -ne $health) { "ready" } else { "starting" }
    pid = $listener.OwningProcess
    port = $Port
    command = if ($null -ne $processInfo) { $processInfo.CommandLine } else { $null }
    health = $health
    pid_file = Test-Path -LiteralPath $pidFile
} | ConvertTo-Json -Depth 6

if ($null -eq $health) { exit 2 }
