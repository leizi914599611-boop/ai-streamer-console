@echo off
setlocal EnableDelayedExpansion
rem 弹幕服务（抖音）按需安装：源码 + Python 环境
rem 进度通过 ##STEP## n/m 输出，由 download-manager 解析
cd /d "%~dp0..\.."

echo ##STEP## 1/3 准备弹幕服务源码
if not exist tools\danmu-service mkdir tools\danmu-service
copy /y services\danmu\danmu_service.py tools\danmu-service\ >nul || exit /b 1
copy /y services\danmu\douyin_proto.py tools\danmu-service\ >nul || exit /b 1
copy /y services\danmu\sign.js tools\danmu-service\ >nul || exit /b 1

echo ##STEP## 2/3 创建 Python 环境（tools\danmuenv）
if not exist tools\danmuenv\Scripts\python.exe (
  where py >nul 2>nul
  if !errorlevel! == 0 (
    py -3 -m venv tools\danmuenv || exit /b 1
  ) else (
    python -m venv tools\danmuenv || exit /b 1
  )
)

echo ##STEP## 3/3 安装依赖（阿里云镜像）
tools\danmuenv\Scripts\python.exe -m pip install --upgrade pip || exit /b 1
tools\danmuenv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" websocket-client requests pydantic py_mini_racer betterproto python-dotenv || exit /b 1

echo ##STEP## 3/3 弹幕服务安装完成
exit /b 0
