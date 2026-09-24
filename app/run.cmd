@echo off
rem Build and run the server. The same as run.sh does on macOS and Linux.
rem
rem   run.cmd
rem   run.cmd --port 9000
rem   run.cmd --impair "loss=2%%,delay=25ms,jitter=5ms,rate=30mbit"
rem
rem Plain Java 21 and plain HTML/JS: no dependencies, no build tools.
setlocal
cd /d "%~dp0"

if not exist server\build mkdir server\build

rem Every class is reachable from one of these four, and javac follows the source path to the
rem rest, so there is no list of files to keep up to date here or in run.sh.
javac -Xlint:all -d server\build -sourcepath server\src ^
    server\src\p2\Main.java ^
    server\src\p2\fec\FecSelfTest.java ^
    server\src\p2\net\udp\UdpSelfTest.java ^
    server\src\p2\net\udp\TransferSelfTest.java
if errorlevel 1 exit /b 1

java -cp server\build p2.Main --web web --images images %*
