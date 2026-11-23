#!/usr/bin/env bash
# Drive the built app in the Even Hub simulator (headless, Xvfb) through a list of
# inputs and save a glasses screenshot after each step.
# Usage: ./sim_demo.sh <out_dir> "<query>" action1 action2 ...
#   actions: click | double_click | up | down | long_press
# Needs: npm run build; simulator 0.9.5 from ../env; xvfb-run.
set -u
cd "$(dirname "$0")"
OUT=${1:?out dir}; Q=${2:-}; shift 2
WEB=${WEB_PORT:-5174}; AP=${AUTOMATION_PORT:-9899}
SIM=../env/node_modules/.bin/evenhub-simulator
mkdir -p "$OUT"
cleanup(){ kill ${SIMPID:-} ${WEBPID:-} 2>/dev/null; pkill -f "evenhub-simulator http://127.0.0.1:$WEB" 2>/dev/null; true; }
trap cleanup EXIT
npx vite preview --host 127.0.0.1 --port "$WEB" --strictPort >"$OUT/web.log" 2>&1 & WEBPID=$!
for i in $(seq 1 20); do curl -sf -m 1 "http://127.0.0.1:$WEB/" >/dev/null && break; sleep 0.5; done
xvfb-run -a -s "-screen 0 1280x900x24" "$SIM" "http://127.0.0.1:$WEB/$Q" --automation-port "$AP" >"$OUT/sim.log" 2>&1 & SIMPID=$!
for i in $(seq 1 30); do [ "$(curl -s -m 1 "http://127.0.0.1:$AP/api/ping")" = pong ] && break; sleep 0.5; done
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$AP/api/console" | grep -q '\[glance\] screen' && break; sleep 0.5; done
sleep 0.5
n=0
shot(){ curl -sf -o "$OUT/$(printf %02d $n)-$1.png" "http://127.0.0.1:$AP/api/screenshot/glasses" && echo "shot $(printf %02d $n)-$1.png"; n=$((n+1)); }
shot start
for a in "$@"; do
  curl -sf -XPOST -H 'content-type: application/json' -d "{\"action\":\"$a\"}" "http://127.0.0.1:$AP/api/input" >/dev/null || echo "input $a failed"
  sleep 0.8; shot "$a"
done
curl -s "http://127.0.0.1:$AP/api/console" > "$OUT/console.json"
echo "screens logged: $(grep -o '\[glance\] screen' "$OUT/console.json" | wc -l)"
