@echo off
rem Starts the dev server for the curling game and opens the page in the default
rem browser. Needs Node 18+ on the PATH. Double-click it, or run it from a shell.
rem Pass a port to use another one:  play.cmd 8000
cd /d "%~dp0"
node serve.mjs %*
