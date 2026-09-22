#!/bin/sh
# Convert an image into a ladder tile store so the server can stream it without ever
# decoding the original. Required for anything too large to hold in memory.
#
#   ./ingest.sh ../images/eso1242a.tif
#   ./ingest.sh ../images/eso1242a.tif --tile 256 --ratio 1.25 --q 0.85
#
# Writes to <images>/.tiles/<name>/ — delete that directory to re-ingest.
set -e
cd "$(dirname "$0")"

if [ $# -lt 1 ]; then
  echo "usage: ./ingest.sh <image> [--tile n] [--ratio r] [--q q]"
  exit 1
fi

mkdir -p build
javac -d build $(find src -name '*.java')
exec java -Xmx2g -cp build project2.Ingest "$@"
