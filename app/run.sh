#!/bin/sh
# Build and run the server.
#
#   ./run.sh                              serve ./images
#   ./run.sh --images ../ideas/images     serve images prepared earlier
#   ./run.sh --port 9000
#   ./run.sh --impair "loss=2%,delay=25ms,jitter=5ms,rate=30mbit"
#
# Everything is plain Java 21 and plain HTML/JS - no dependencies, no build tools.
# On Windows use run.cmd, which does exactly the same thing.
set -e
cd "$(dirname "$0")"

mkdir -p server/build
# Every class is reachable from one of these four, and javac follows the source path to the
# rest, so there is no list of files to keep up to date and nothing written to a temporary
# directory - which is also what lets run.cmd be the same two commands on Windows.
javac -Xlint:all -d server/build -sourcepath server/src \
    server/src/p2/Main.java \
    server/src/p2/fec/FecSelfTest.java \
    server/src/p2/net/udp/UdpSelfTest.java \
    server/src/p2/net/udp/TransferSelfTest.java

exec java -cp server/build p2.Main --web web --images images "$@"
