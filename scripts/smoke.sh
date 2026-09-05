#!/usr/bin/env bash
# Noobty M1 backend end-to-end smoke test.
#
# Builds the debug binary (if missing), boots the hub on a test port with a
# throwaway data dir, exercises the whole M1 API surface and exits non-zero
# on any failed assertion.
#
# Usage: scripts/smoke.sh [port]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-7417}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
FAILURES=0
SRV=""

pass() { printf '  OK  %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { # check <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected [$2], got [$3])"; fi
}

cd "$ROOT"
if [ ! -x server/target/debug/noobty-server.exe ] && [ ! -x server/target/debug/noobty-server ]; then
  cargo build --manifest-path server/Cargo.toml -q
fi
BIN=server/target/debug/noobty-server.exe
[ -x "$BIN" ] || BIN=server/target/debug/noobty-server

cat > "$TMP/config.toml" <<EOF
port = $PORT
web_dir = "$ROOT/web/dist"
storage_path = "$TMP/data"
EOF

NOOBTY_CONFIG="$TMP/config.toml" "$BIN" >"$TMP/server.log" 2>&1 &
SRV=$!
cleanup() {
  local wpid=""
  [ -n "$SRV" ] && wpid="$(cat "/proc/$SRV/winpid" 2>/dev/null || true)"
  [ -n "$wpid" ] && taskkill //F //PID "$wpid" >/dev/null 2>&1
  kill "$SRV" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
sleep 2

jid() {
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let v=JSON.parse(d);for(const k of process.argv[1].split('.'))v=v?.[k];console.log(v ?? '')})" "$1"
}

echo "== health"
check "healthz reports ok" "true" "$(curl -s "$BASE/api/healthz" | jid ok)"

echo "== devices"
A=$(curl -s -X POST "$BASE/api/devices/register" -H 'content-type: application/json' -d '{"name":"smoke-a"}' | jid device_id)
B=$(curl -s -X POST "$BASE/api/devices/register" -H 'content-type: application/json' -d '{"name":"smoke-b"}' | jid device_id)
[ -n "$A" ] && pass "registered smoke-a" || fail "register smoke-a"
[ -n "$B" ] && pass "registered smoke-b" || fail "register smoke-b"

# WS listener on B: events must be PUSHED by the hub (no polling anywhere).
cat > "$TMP/ws_client.mjs" <<'EOF'
const ws = new WebSocket(process.argv[2]);
ws.onmessage = (e) => console.log("WS-EVENT", e.data);
ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
setTimeout(() => process.exit(0), 9000);
EOF
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$B" >"$TMP/ws.log" 2>&1 &
sleep 1.2

echo "== realtime push"
curl -s -X POST "$BASE/api/conversations/private:$B/texts" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"text":"smoke hello"}' >/dev/null
sleep 0.8
grep -q '"type":"pong"' "$TMP/ws.log" && pass "application-level ping/pong" || fail "ping/pong"
grep -q '"type":"hello"' "$TMP/ws.log" && pass "hello on connect" || fail "hello on connect"
grep -q '"kind":"text"' "$TMP/ws.log" && pass "text message pushed" || fail "text message pushed"

echo "== resumable upload (tus-style sequential append)"
head -c 262144 /dev/urandom >"$TMP/blob.bin"
SUM=$(sha256sum "$TMP/blob.bin" | cut -d' ' -f1)
head -c 100000 "$TMP/blob.bin" >"$TMP/p1.bin"
tail -c +100001 "$TMP/blob.bin" >"$TMP/p2.bin"
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({name:'测试包.bin',size:262144,sha256:process.argv[2]}))" "$TMP/req.json" "$SUM"
UP=$(curl -s -X POST "$BASE/api/uploads" -H "X-Noobty-Device: $A" -H 'content-type: application/json' --data-binary @"$TMP/req.json" | jid upload_id)
[ -n "$UP" ] && pass "upload session created (utf-8 filename)" || fail "upload session created"

check "part 1 stored" "100000" \
  "$(curl -s -X PUT "$BASE/api/uploads/$UP" -H "X-Noobty-Device: $A" -H "X-Noobty-Offset: 0" --data-binary @"$TMP/p1.bin" | jid received_bytes)"

CODE=$(curl -s -o "$TMP/conflict.json" -w "%{http_code}" -X PUT "$BASE/api/uploads/$UP" -H "X-Noobty-Device: $A" -H "X-Noobty-Offset: 5" --data-binary @"$TMP/p1.bin")
check "stale offset rejected" "409" "$CODE"
check "conflict carries server offset" "100000" "$(jid current_offset <"$TMP/conflict.json")"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/uploads/$UP" -H "X-Noobty-Device: $B" -H "X-Noobty-Offset: 100000" --data-binary @"$TMP/p2.bin")
check "foreign device rejected" "403" "$CODE"

check "resume info after interruption" "100000" \
  "$(curl -s "$BASE/api/uploads/$UP" -H "X-Noobty-Device: $A" | jid received_bytes)"

check "part 2 stored" "262144" \
  "$(curl -s -X PUT "$BASE/api/uploads/$UP" -H "X-Noobty-Device: $A" -H "X-Noobty-Offset: 100000" --data-binary @"$TMP/p2.bin" | jid received_bytes)"

RESP=$(curl -s -X POST "$BASE/api/uploads/$UP/complete" -H "X-Noobty-Device: $A" -H 'content-type: application/json' -d "{\"conversation_id\":\"private:$B\",\"as_message\":true}")
FID=$(echo "$RESP" | jid file_id)
[ -n "$FID" ] && pass "completed as message" || fail "completed as message"
sleep 0.8
grep -q '"kind":"file"' "$TMP/ws.log" && pass "file message pushed" || fail "file message pushed"

echo "== storage accounting"
check "used equals file size (no zombie upload row)" "262144" "$(curl -s "$BASE/api/storage" | jid used_bytes)"

echo "== download"
curl -s -o "$TMP/dl.bin" "$BASE/api/files/$FID"
check "sha256 round-trip" "$SUM" "$(sha256sum "$TMP/dl.bin" | cut -d' ' -f1)"
CODE=$(curl -s -o "$TMP/r.bin" -w "%{http_code}" -H "Range: bytes=0-9" "$BASE/api/files/$FID")
check "range request partial content" "206" "$CODE"
check "range length" "10" "$(( $(wc -c <"$TMP/r.bin") ))"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=99999999-" "$BASE/api/files/$FID")
check "unsatisfiable range" "416" "$CODE"

echo "== deletion cascades"
MID=$(curl -s "$BASE/api/conversations/private:$B/messages?limit=1" | jid messages.0.message_id)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/messages/$MID" -H "X-Noobty-Device: $B")
check "delete file message" "204" "$CODE"
check "blob removed from disk" "0" "$(( $(ls "$TMP/data/files" 2>/dev/null | wc -l) ))"
check "quota freed" "0" "$(curl -s "$BASE/api/storage" | jid used_bytes)"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "SMOKE PASS"
else
  echo "SMOKE FAILED: $FAILURES assertion(s)"
fi
exit "$FAILURES"
