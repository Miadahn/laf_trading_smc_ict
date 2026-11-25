@echo off
rem Demarre le serveur SMC . ICT et ouvre l'application dans le navigateur.
rem Double-cliquer ce fichier suffit : il se place tout seul dans le bon dossier.

rem Se placer dans le dossier de ce fichier, quel que soit l'endroit d'ou on le lance
cd /d "%~dp0"

echo.
echo === SMC . ICT Analyzer ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERREUR : Node.js est introuvable.
  echo Installer Node.js 22 ou plus recent depuis https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo Ouverture de http://127.0.0.1:8787 dans le navigateur...
rem Laisser au serveur le temps d'ecouter avant d'ouvrir la page
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start """" http://127.0.0.1:8787"

echo.
echo NE PAS FERMER CETTE FENETRE : le serveur tourne dedans.
echo Pour l'arreter : Ctrl+C, ou fermer cette fenetre.
echo.

node server/server.js

rem On n'arrive ici que si le serveur s'arrete ou plante : garder la fenetre
rem ouverte pour que le message d'erreur reste lisible.
echo.
echo Le serveur s'est arrete.
pause
