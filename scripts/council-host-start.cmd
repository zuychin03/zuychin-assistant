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

setlocal
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

node --no-warnings --import tsx --env-file=.env.local scripts\council-host.mts --repo "%REPO%" %*
