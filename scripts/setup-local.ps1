param(
    [string]$InstallRoot = "D:\SpecJevLocal",
    [ValidateSet("cpu", "cu130")]
    [string]$TorchBackend = "cu130"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required. Install it from https://docs.astral.sh/uv/ first."
}

$venv = Join-Path $InstallRoot ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$uvCache = Join-Path $InstallRoot "cache\uv"
$temp = Join-Path $InstallRoot "cache\temp"
$modelDir = Join-Path $InstallRoot "models\Qwen3-Reranker-0.6B"
$modelFile = Join-Path $modelDir "model.safetensors"
$modelId = "Qwen/Qwen3-Reranker-0.6B"
$expectedModelSha256 = "27CD75A405B9C1B46B59ABFD88AAA209E6FED2A1972CDE9B70E7659537C5E65B"

New-Item -ItemType Directory -Force -Path $InstallRoot, $uvCache, $temp, (Join-Path $InstallRoot "models"), (Join-Path $InstallRoot "logs") | Out-Null
$env:UV_CACHE_DIR = $uvCache
$env:TEMP = $temp
$env:TMP = $temp
$env:MODELSCOPE_CACHE = Join-Path $InstallRoot "cache\modelscope"

if (-not (Test-Path -LiteralPath $python)) {
    uv venv --python 3.13 $venv
}

$installedTorch = (& $python -c "import torch; print(torch.__version__)" 2>$null)
if ($TorchBackend -eq "cu130" -and $installedTorch -ne "2.14.0+cu130") {
    uv pip install --python $python --reinstall "torch==2.14.0+cu130" --index-url https://download.pytorch.org/whl/cu130
} elseif ($TorchBackend -eq "cpu" -and $installedTorch -ne "2.14.0+cpu") {
    uv pip install --python $python --reinstall "torch==2.14.0+cpu" --index-url https://download.pytorch.org/whl/cpu
}

uv pip install --python $python "transformers>=5.0,<6" "modelscope>=1.35,<2" safetensors

if (-not (Test-Path -LiteralPath $modelFile)) {
    $modelscope = Join-Path $venv "Scripts\modelscope.exe"
    & $modelscope download $ModelId --local-dir $modelDir --max-workers 4
}

$actualModelSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $modelFile).Hash
if ($actualModelSha256 -ne $expectedModelSha256) {
    throw "Model checksum mismatch at $modelFile"
}

Write-Host "JevRev local runtime is ready at $InstallRoot"
Write-Host "Start it with: powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1"
