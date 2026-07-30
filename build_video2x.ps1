# video2x build script for Windows
# Run as Administrator!
# Usage: powershell -ExecutionPolicy Bypass -File build_video2x.ps1

$ErrorActionPreference = "Stop"
# 项目目录自动取脚本所在位置，克隆到任意路径均可直接运行
$ProjectDir = $PSScriptRoot

Write-Host "============================================"
Write-Host "  video2x Windows Build Script"
Write-Host "============================================"

Set-Location $ProjectDir

# Step 1: CMake
Write-Host "[1/7] Checking CMake..."
$cmakeCmd = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmakeCmd) {
    Write-Host "  Installing CMake..."
    winget install -e --id=Kitware.CMake --accept-source-agreements --accept-package-agreements --silent
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = $machinePath + ";" + $userPath
}
$cmakeCmd = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmakeCmd) {
    $env:Path = $env:Path + ";C:\Program Files\CMake\bin"
}
cmake --version

# Step 2: Vulkan SDK
Write-Host "[2/7] Checking Vulkan SDK..."
$vkSdk = [System.Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
if (-not $vkSdk -or -not (Test-Path $vkSdk)) {
    Write-Host "  Installing Vulkan SDK..."
    winget install -e --id=KhronosGroup.VulkanSDK --accept-source-agreements --accept-package-agreements
    $vkSdk = [System.Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
    $env:VULKAN_SDK = $vkSdk
}
if (-not $vkSdk) {
    $vkDirs = Get-ChildItem "C:\VulkanSDK" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($vkDirs) {
        $vkSdk = $vkDirs.FullName
        $env:VULKAN_SDK = $vkSdk
    }
}
Write-Host "  Vulkan SDK: $vkSdk"

# Step 3: VS Build Tools
Write-Host "[3/7] Checking VS C++ compiler..."
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstall = $null
if (Test-Path $vswhere) {
    $vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
}
if (-not $vsInstall) {
    Write-Host "  Installing VS Build Tools 2022 with C++ workload..."
    Write-Host "  This may take 10-20 minutes..."
    $overrideArgs = "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    winget install -e --id=Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override $overrideArgs
    $vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
}
if (-not $vsInstall) {
    Write-Host "[ERROR] VS C++ compiler not found!"
    exit 1
}
Write-Host "  VS: $vsInstall"

# Step 4: FFmpeg
Write-Host "[4/7] Checking FFmpeg..."
$ffVer = "7.1"
if (-not (Test-Path "third_party\ffmpeg-shared\include")) {
    Write-Host "  Downloading FFmpeg $ffVer..."
    $ffUrl = "https://github.com/GyanD/codexffmpeg/releases/download/$ffVer/ffmpeg-$ffVer-full_build-shared.zip"
    Invoke-WebRequest -Uri $ffUrl -OutFile "third_party\ffmpeg-shared.zip" -UseBasicParsing
    Expand-Archive -Path "third_party\ffmpeg-shared.zip" -DestinationPath "third_party" -Force
    if (Test-Path "third_party\ffmpeg-shared") { Remove-Item "third_party\ffmpeg-shared" -Recurse -Force }
    Rename-Item "third_party\ffmpeg-$ffVer-full_build-shared" "ffmpeg-shared"
    Remove-Item "third_party\ffmpeg-shared.zip" -Force -ErrorAction SilentlyContinue
}
Write-Host "  FFmpeg: OK"

# Step 5: ncnn
Write-Host "[5/7] Checking ncnn..."
$ncnnVer = "20240820"
if (-not (Test-Path "third_party\ncnn-shared\x64\include")) {
    Write-Host "  Downloading ncnn $ncnnVer..."
    $ncnnUrl = "https://github.com/Tencent/ncnn/releases/download/$ncnnVer/ncnn-$ncnnVer-windows-vs2022-shared.zip"
    Invoke-WebRequest -Uri $ncnnUrl -OutFile "third_party\ncnn-shared.zip" -UseBasicParsing
    Expand-Archive -Path "third_party\ncnn-shared.zip" -DestinationPath "third_party" -Force
    if (Test-Path "third_party\ncnn-shared") { Remove-Item "third_party\ncnn-shared" -Recurse -Force }
    Rename-Item "third_party\ncnn-$ncnnVer-windows-vs2022-shared" "ncnn-shared"
    Remove-Item "third_party\ncnn-shared.zip" -Force -ErrorAction SilentlyContinue
}
Write-Host "  ncnn: OK"

# Step 6: Configure MSVC env
Write-Host "[6/7] Configuring build environment..."
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvarsall.bat"
if (Test-Path $vcvars) {
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "cmd.exe"
    $pinfo.Arguments = "/c `"$vcvars`" x64 >nul 2>&1 && set"
    $pinfo.RedirectStandardOutput = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($pinfo)
    $output = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    foreach ($line in $output.Split("`n")) {
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -gt 0) {
            $key = $line.Substring(0, $eqIdx).Trim()
            $val = $line.Substring($eqIdx + 1).Trim()
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
    Write-Host "  MSVC environment configured"
}

# Ensure VULKAN_SDK is set (vcvarsall may have overwritten it)
$vkSdkMachine = [System.Environment]::GetEnvironmentVariable("VULKAN_SDK", "Machine")
if ($vkSdkMachine) {
    $env:VULKAN_SDK = $vkSdkMachine
    Write-Host "  VULKAN_SDK: $env:VULKAN_SDK"
}

# Step 7: Build
Write-Host "[7/7] Building video2x..."

# if (Test-Path "build") {
#     Remove-Item "build" -Recurse -Force
# }

cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=build/video2x-install -DCMAKE_INSTALL_BINDIR=bin -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_INCLUDEDIR=include -DCMAKE_INSTALL_DATADIR=share -DVIDEO2X_USE_EXTERNAL_NCNN=OFF -DVIDEO2X_USE_EXTERNAL_SPDLOG=OFF -DVIDEO2X_USE_EXTERNAL_BOOST=OFF -DCMAKE_PREFIX_PATH="$env:VULKAN_SDK"

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] CMake configure failed!"

    exit 1
}

cmake --build build --config Release --parallel --target install

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!"
    exit 1
}

Write-Host ""
Write-Host "============================================"
Write-Host "  Build successful!"
Write-Host "============================================"
Write-Host "Output: $ProjectDir\build\video2x-install\"
Write-Host "Test: .\video2x.exe --help"
