#!/bin/sh
# Build and run Project 2. Java 21, no dependencies, no build tool - it must compile anywhere.
#
#   ./run.sh                          # serves every image in ../images
#   ./run.sh 9000                     # same, on another port
#   ./run.sh ../images 8080           # explicit directory
#   ./run.sh some/photo.jpg           # serves that file's directory
#
# Options: --ratio 1.25  --tile 256  --q 0.85
set -e
cd "$(dirname "$0")"

mkdir -p build ../images
javac -d build $(find src -name '*.java')
exec java -cp build project2.Main "$@"
