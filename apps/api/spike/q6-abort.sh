#!/bin/bash
# Usage: q6-abort.sh <AUTH_INIT> <trials> <abort-seconds> <burst>
# Starts a cold `wrangler dev`, aborts the first auth request(s), then checks whether later auth requests hang.
set -u
cd "$(dirname "$0")/.."
variant=$1; trials=$2; abort=$3; burst=$4; port=8793
for t in $(seq 1 "$trials"); do
  ./node_modules/.bin/wrangler dev --port $port --ip 127.0.0.1 --inspector-port 9293 --persist-to .wrangler/state-8787 \
    --var BETTER_AUTH_URL:http://localhost:$port --var AUTH_INIT:$variant > /tmp/spike163-q6-$variant-$t.log 2>&1 &
  wpid=$!
  until grep -q "Ready on" /tmp/spike163-q6-$variant-$t.log; do sleep 0.1; done
  echo "cancel-first: $(curl -s -m 5 "http://127.0.0.1:$port/spike/cancel-first?ms=${CANCEL_MS:-1}")"
  pids=()
  for b in $(seq 1 "$burst"); do curl -s -o /dev/null -m "$abort" http://127.0.0.1:$port/api/auth/get-session & pids+=($!); done
  wait "${pids[@]}"
  ok=0; hung=0
  for n in $(seq 1 5); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:$port/api/auth/get-session)
    if [ "$code" = "200" ]; then ok=$((ok+1)); else hung=$((hung+1)); fi
  done
  echo "variant=$variant trial=$t abort=${abort}s burst=$burst follow-ups: ok=$ok hung_or_failed=$hung"
  kill $wpid; wait $wpid 2>/dev/null
  while lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; do sleep 0.2; done
done
