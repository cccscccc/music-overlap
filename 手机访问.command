#!/bin/sh
# macOS 双击入口：交给同目录的 手机访问.sh 干活。
DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
exec "$DIR/手机访问.sh" "$@"
