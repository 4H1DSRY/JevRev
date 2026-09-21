param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [string]$Model = "",
    [string]$LlamaRoot = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Model)) {
    $Model = Join-Path $InstallRoot "models\Qwen3.5-4B-GGUF\Qwen_Qwen3.5-4B-Q4_K_M.gguf"
}
if ([string]::IsNullOrWhiteSpace($LlamaRoot)) {
    $LlamaRoot = Join-Path $InstallRoot "llama-b9222"
}

$server = Join-Path $LlamaRoot "llama-server.exe"
$expectedModelBytes = [int64]3013027808
$expectedModelSha256 = "13C16F426047E2DE38CD075BDADE4A7BCBC8C774384876F677740CDA65F8A983"

if (-not (Test-Path -LiteralPath $server)) { throw "Missing $server" }
if (-not (Test-Path -LiteralPath $Model)) { throw "Missing $Model" }
$file = Get-Item -LiteralPath $Model
if ($file.Length -ne $expectedModelBytes) {
    throw "Unexpected GGUF size ($($file.Length)); expected $expectedModelBytes."
}
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Model).Hash
if ($actualSha256 -ne $expectedModelSha256) {
    throw "GGUF checksum mismatch: $actualSha256"
}

Write-Output "SemIf artifacts are present and verified."
Write-Output "llama-server: $server"
Write-Output "model: $Model"
Write-Output "sha256: $actualSha256"
