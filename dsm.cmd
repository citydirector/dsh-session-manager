@echo off
setlocal EnableDelayedExpansion
rem DSH 会话管理器启动脚本：找一个 Node 22.15+ 运行 bin\dsm.mjs。
rem 优先级：%DSM_NODE% → DSH 便携版\node\node.exe → DSH 桌面版自带 node → PATH 里的 node。
chcp 65001 >nul
set "HERE=%~dp0"
set "NODE="
if defined DSM_NODE if exist "%DSM_NODE%" set "NODE=%DSM_NODE%"
if not defined NODE (
  for %%R in ("%HERE%" "%HERE%.." "%HERE%..\.." "%HERE%..\..\.." "D:\dsh-portable" "C:\dsh-portable" "E:\dsh-portable" "D:\dsh-desktop" "C:\dsh-desktop" "E:\dsh-desktop") do (
    if not defined NODE if exist "%%~R\node\node.exe" set "NODE=%%~R\node\node.exe"
    if not defined NODE if exist "%%~R\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE=%%~R\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  )
)
if not defined NODE (
  where node >nul 2>nul && set "NODE=node"
)
if not defined NODE (
  echo 找不到 Node.js。请安装 Node 22.15+，或设置 DSM_NODE 指向 node.exe。
  pause
  exit /b 1
)
"%NODE%" "%HERE%bin\dsm.mjs" %*
set "CODE=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %CODE%
