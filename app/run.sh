#!/bin/sh
# Build and run the server.
#
#   ./run.sh                              serve ./images
#   ./run.sh --images ../ideas/images     serve images prepared earlier
#   ./run.sh --port 9000
#
# Everything is plain Java 21 and plain HTML/JS - no dependencies, no build tools.
set -e
cd "$(dirname "$0")"

mkdir -p server/build
find server/src -name '*.java' > /tmp/p2-sources.txt
javac -Xlint:all -d server/build @/tmp/p2-sources.txt

exec java -cp server/build p2.Main --web web --images images "$@"
