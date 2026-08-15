@echo off
setlocal
rem Builds the Rust inference engine on Windows.
rem llama.cpp is compiled from source by llama-cpp-2, so MSVC and CMake must be
rem on PATH before cargo runs. vcvars64.bat is what puts them there.

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: vswhere.exe not found - no Visual Studio installation detected.
  exit /b 1
)

for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"

if not defined VSPATH (
  echo ERROR: No MSVC C++ toolchain found. Install it with:
  echo   winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.CMake.Project --includeRecommended"
  exit /b 1
)

echo Using Visual Studio at: %VSPATH%
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo ERROR: vcvars64.bat failed.
  exit /b 1
)

set "PATH=%USERPROFILE%\.cargo\bin;%VSPATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"

rem llama-cpp-sys-2 generates bindings with bindgen, which loads libclang.dll at
rem build time. MSVC does not ship it, so point LIBCLANG_PATH at whichever LLVM
rem is present: the VS Clang component or a standalone LLVM install.
if not defined LIBCLANG_PATH (
  if exist "%VSPATH%\VC\Tools\Llvm\x64\bin\libclang.dll" set "LIBCLANG_PATH=%VSPATH%\VC\Tools\Llvm\x64\bin"
)
if not defined LIBCLANG_PATH (
  if exist "%ProgramFiles%\LLVM\bin\libclang.dll" set "LIBCLANG_PATH=%ProgramFiles%\LLVM\bin"
)
if not defined LIBCLANG_PATH (
  echo ERROR: libclang.dll not found - bindgen cannot generate llama.cpp bindings.
  echo Install LLVM with: winget install LLVM.LLVM
  exit /b 1
)
echo Using libclang at: %LIBCLANG_PATH%

where cargo >nul 2>&1 || (echo ERROR: cargo not on PATH. Install Rust from https://rustup.rs & exit /b 1)
where cmake >nul 2>&1 || (echo ERROR: cmake not on PATH. & exit /b 1)

cd /d "%~dp0..\apps\inference-engine" || exit /b 1
echo Building inference engine (release)...
cargo build --release %*
