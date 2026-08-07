@echo off
rem Starts the council host for this checkout. Paths are derived from this
rem file's own location, so the same script works from any clone or drive.
rem
rem   --import tsx, never --experimental-strip-types: the council library uses
rem   extensionless relative imports and the "@/" alias, and plain node ESM
rem   resolves neither.
rem
rem Run it directly to start a host in this window, or point a one-line .vbs
rem shim in the Startup folder at it to run it hidden at login.
rem
rem Every argument is forwarded to the host, so a launcher can pin a starting
rem repo and a model without editing council-agents.json:
rem
rem   council-host-start.cmd --repo D:\code\other-app --base develop
rem   council-host-start.cmd --model "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]"
rem
rem --repo only sets where the host STARTS. Which repos a council may be
rem convened against is host.repos in council-agents.json, because that list is
rem what the browser is allowed to choose from.

setlocal enabledelayedexpansion
set "REPO=%~dp0.."
cd /d "%REPO%"

if not exist ".env.local" (
  echo Missing .env.local in %REPO% - MCP_API_KEY has to come from somewhere.
  exit /b 1
)
if not exist "scripts\council-agents.json" (
  echo Missing scripts\council-agents.json - copy council-agents.example.json first.
  exit /b 1
)

rem Default --repo to this checkout, but never pass it twice: the host reads the
rem first occurrence, so an injected default would silently beat the caller's.
set "REPOARG=--repo "%REPO%""
for %%a in (%*) do (
  if /i "%%~a"=="--repo" set "REPOARG="
)

node --no-warnings --import tsx --env-file=.env.local scripts\council-host.mts !REPOARG! %*
