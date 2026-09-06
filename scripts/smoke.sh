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
# Prefer the release binary (production-parity), fall back to debug, and
# build one only if neither exists.
BIN=server/target/release/noobty-server.exe
[ -x "$BIN" ] || BIN=server/target/release/noobty-server
[ -x "$BIN" ] || BIN=server/target/debug/noobty-server.exe
[ -x "$BIN" ] || BIN=server/target/debug/noobty-server
if [ ! -x "$BIN" ]; then
  cargo build --release --manifest-path server/Cargo.toml -q
  BIN=server/target/release/noobty-server.exe
  [ -x "$BIN" ] || BIN=server/target/release/noobty-server
fi

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
# Every received message is auto-acked so the sender-side ack can be verified.
# Lifetime is configurable so the test can simulate a disconnect.
cat > "$TMP/ws_client.mjs" <<'EOF'
const ws = new WebSocket(process.argv[2]);
const lifetime = Number(process.argv[3] || 9000);
ws.onmessage = (e) => {
  console.log("WS-EVENT", e.data);
  const frame = JSON.parse(e.data);
  if (frame.type === "message") {
    ws.send(JSON.stringify({ type: "ack_message", message_id: frame.message_id }));
  }
};
ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
ws.onclose = () => console.log("WS-CLOSED");
setTimeout(() => process.exit(0), lifetime);
EOF
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$B" 3500 >"$TMP/ws.log" 2>&1 &
sleep 1.2

echo "== realtime push"
curl -s -X POST "$BASE/api/conversations/private:$B/texts" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"text":"smoke hello"}' >/dev/null
sleep 0.8
grep -q '"type":"pong"' "$TMP/ws.log" && pass "application-level ping/pong" || fail "ping/pong"
grep -q '"type":"hello"' "$TMP/ws.log" && pass "hello on connect" || fail "hello on connect"
grep -q '"kind":"text"' "$TMP/ws.log" && pass "text message pushed" || fail "text message pushed"
sleep 0.6
ACKED=$(curl -s "$BASE/api/conversations/private:$B/messages?limit=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const m=o.messages.find(m=>m.kind==='text');console.log(m?.acked_at ?? '')})")
[ -n "$ACKED" ] && pass "ack persisted (acked_at in history, survives offline sender)" || fail "ack persisted"

echo "== seq recovery (disconnect → miss push → after_seq catch-up)"
# Wait for B's WS to die so the next message is missed (push is best-effort).
sleep 2.5
# Snapshot the recovery cursor before the offline message lands.
LAST_SEQ=$(curl -s "$BASE/api/conversations/private:$B/messages?limit=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const n=Math.max(0,...(o.messages||[]).map(m=>m.seq||0));console.log(n)})")
[ -n "$LAST_SEQ" ] && pass "recovery cursor seq=$LAST_SEQ" || fail "recovery cursor"
curl -s -X POST "$BASE/api/conversations/private:$B/texts" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"text":"missed while offline"}' >/dev/null
# Offline: the dead WS must not have seen it.
grep -q 'missed while offline' "$TMP/ws.log" && fail "offline message must not be pushed to dead WS" || pass "offline message not pushed (expected)"
# Reconnect catch-up via after_seq (preferred over message-id cursor).
CAUGHT=$(curl -s "$BASE/api/conversations/private:$B/messages?after_seq=${LAST_SEQ}&limit=50")
CAUGHT_TEXT=$(printf '%s' "$CAUGHT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const m=(o.messages||[]).find(x=>x.text==='missed while offline');console.log(m?m.seq:'')})")
[ -n "$CAUGHT_TEXT" ] && pass "after_seq catch-up recovers missed message (seq=$CAUGHT_TEXT)" || fail "after_seq catch-up"
# seq must be strictly monotonic and present on every message view.
HAS_SEQ=$(curl -s "$BASE/api/conversations/private:$B/messages?limit=20" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const ms=JSON.parse(d).messages||[];const ok=ms.length>0&&ms.every(m=>Number.isInteger(m.seq)&&m.seq>=1);console.log(ok?'yes':'no')})")
check "every message carries seq >= 1" "yes" "$HAS_SEQ"

# Re-attach B for the remaining push assertions (upload → file message).
: >"$TMP/ws.log"
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$B" 20000 >"$TMP/ws.log" 2>&1 &
sleep 0.8

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

echo "== upload cancellation (tus termination)"
UPC=$(curl -s -X POST "$BASE/api/uploads" -H "X-Noobty-Device: $A" -H 'content-type: application/json' -d '{"name":"cancel-me.bin","size":1000}' | jid upload_id)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/uploads/$UPC" -H "X-Noobty-Device: $A")
check "cancel in-progress upload" "204" "$CODE"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/uploads/$UPC" -H "X-Noobty-Device: $A")
check "cancelled session is gone" "404" "$CODE"

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

echo "== lobby broadcast"
# Both A and B online: a lobby text must fan-out to every live socket.
: >"$TMP/ws_a.log"
: >"$TMP/ws_b.log"
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$A" 6000 >"$TMP/ws_a.log" 2>&1 &
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$B" 6000 >"$TMP/ws_b.log" 2>&1 &
sleep 0.8
LOBBY=$(curl -s -X POST "$BASE/api/conversations/lobby/texts" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"text":"lobby hello everyone"}')
LOBBY_SEQ=$(printf '%s' "$LOBBY" | jid seq)
[ -n "$LOBBY_SEQ" ] && pass "lobby text accepted (seq=$LOBBY_SEQ)" || fail "lobby text accepted"
sleep 0.6
grep -q 'lobby hello everyone' "$TMP/ws_a.log" && pass "lobby echoed to sender" || fail "lobby echoed to sender"
grep -q 'lobby hello everyone' "$TMP/ws_b.log" && pass "lobby pushed to peer" || fail "lobby pushed to peer"
# History on the shared thread is readable by any device.
LOBBY_HIST=$(curl -s "$BASE/api/conversations/lobby/messages?limit=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const m=(o.messages||[]).find(x=>x.text==='lobby hello everyone');console.log(m&&m.conversation_id==='lobby'?'yes':'no')})")
check "lobby history readable" "yes" "$LOBBY_HIST"

echo "== streaming relay (tee to disk + live splice)"
# Offline peer → must fall back to store-and-forward.
CODE=$(curl -s -o "$TMP/relay_off.json" -w "%{http_code}" -X POST "$BASE/api/relays" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d "{\"name\":\"offline.bin\",\"size\":16,\"conversation_id\":\"private:$B\"}")
# B's WS from lobby section may still be alive — kill wait then re-check with a
# device that has no socket: register C with no WS.
C=$(curl -s -X POST "$BASE/api/devices/register" -H 'content-type: application/json' -d '{"name":"smoke-c"}' | jid device_id)
CODE=$(curl -s -o "$TMP/relay_off.json" -w "%{http_code}" -X POST "$BASE/api/relays" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d "{\"name\":\"offline.bin\",\"size\":16,\"conversation_id\":\"private:$C\"}")
check "offline peer → 409" "409" "$CODE"
check "offline peer → fallback stored" "stored" "$(jid fallback <"$TMP/relay_off.json")"

# Live splice: keep B online, A offers, B GETs while A PUTs; bytes land on disk.
: >"$TMP/ws_b2.log"
node "$TMP/ws_client.mjs" "ws://127.0.0.1:${PORT}/api/ws?device_id=$B" 20000 >"$TMP/ws_b2.log" 2>&1 &
sleep 0.8
printf 'relay-payload-ok!!' >"$TMP/relay.bin"
RELAY_SIZE=$(wc -c <"$TMP/relay.bin" | tr -d ' ')
RELAY=$(curl -s -X POST "$BASE/api/relays" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d "{\"name\":\"直转.bin\",\"size\":$RELAY_SIZE,\"conversation_id\":\"private:$B\"}")
RID=$(printf '%s' "$RELAY" | jid relay_id)
RFID=$(printf '%s' "$RELAY" | jid file_id)
[ -n "$RID" ] && pass "relay created ($RID)" || fail "relay created"
sleep 0.4
grep -q '"type":"relay_offer"' "$TMP/ws_b2.log" && pass "relay_offer pushed to peer" || fail "relay_offer pushed to peer"

# Receiver attaches first (background), then sender PUTs.
curl -s -o "$TMP/relay_out.bin" -H "X-Noobty-Device: $B" "$BASE/api/relays/$RID" &
RCPID=$!
sleep 0.3
PUTRESP=$(curl -s -X PUT "$BASE/api/relays/$RID" -H "X-Noobty-Device: $A" \
  -H 'content-type: application/octet-stream' --data-binary @"$TMP/relay.bin")
wait "$RCPID" 2>/dev/null || true
PUT_FID=$(printf '%s' "$PUTRESP" | jid file_id)
[ "$PUT_FID" = "$RFID" ] && pass "relay PUT completed (file on disk)" || fail "relay PUT completed"
cmp -s "$TMP/relay.bin" "$TMP/relay_out.bin" && pass "live splice bytes match" || fail "live splice bytes match"
curl -s -o "$TMP/relay_disk.bin" "$BASE/api/files/$RFID"
check "stored blob matches (tee)" "yes" "$(cmp -s "$TMP/relay.bin" "$TMP/relay_disk.bin" && echo yes || echo no)"
# Cleanup relay test file so later quota assertions stay simple if re-run mid-script.
curl -s -o /dev/null -X DELETE "$BASE/api/files/$RFID" -H "X-Noobty-Device: $A" || true

echo "== file_group batch"
# Upload two files without posting messages, then assemble one file_group card.
printf 'batch-a' >"$TMP/ga.bin"
printf 'batch-bb' >"$TMP/gb.bin"
GA=$(curl -s -X POST "$BASE/api/uploads" -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"name":"a.txt","size":7}' | jid upload_id)
GB=$(curl -s -X POST "$BASE/api/uploads" -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d '{"name":"b.txt","size":8}' | jid upload_id)
curl -s -X PUT "$BASE/api/uploads/$GA" -H "X-Noobty-Device: $A" -H "X-Noobty-Offset: 0" --data-binary @"$TMP/ga.bin" >/dev/null
curl -s -X PUT "$BASE/api/uploads/$GB" -H "X-Noobty-Device: $A" -H "X-Noobty-Offset: 0" --data-binary @"$TMP/gb.bin" >/dev/null
FA=$(curl -s -X POST "$BASE/api/uploads/$GA/complete" -H "X-Noobty-Device: $A" -H 'content-type: application/json' -d '{}' | jid file_id)
FB=$(curl -s -X POST "$BASE/api/uploads/$GB/complete" -H "X-Noobty-Device: $A" -H 'content-type: application/json' -d '{}' | jid file_id)
[ -n "$FA" ] && [ -n "$FB" ] && pass "batch files stored without messages" || fail "batch files stored without messages"
GROUP=$(curl -s -X POST "$BASE/api/conversations/private:$B/file-groups" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d "{\"file_ids\":[\"$FA\",\"$FB\"]}")
GKIND=$(printf '%s' "$GROUP" | jid kind)
GCOUNT=$(printf '%s' "$GROUP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log((o.files||[]).length)})")
check "file_group kind" "file_group" "$GKIND"
check "file_group has 2 files" "2" "$GCOUNT"
# Reject single-file group
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/conversations/private:$B/file-groups" \
  -H "X-Noobty-Device: $A" -H 'content-type: application/json' \
  -d "{\"file_ids\":[\"$FA\"]}")
check "file_group rejects <2 files" "400" "$CODE"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "SMOKE PASS"
else
  echo "SMOKE FAILED: $FAILURES assertion(s)"
fi
exit "$FAILURES"
