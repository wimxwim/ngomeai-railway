#!/bin/bash
# SMOKE TEST SCRIPT - 5 WAJIB TEST SEBELUM MERGE KE STABLE
# Dijalankan oleh 🎭 Sandiwara (QA & Testing)
# Jika GAGAL → Rollback, JANGAN merge!

# Load .env file from project root (parent directory of scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
fi

# JANGAN exit on first failure - kita mau lihat semua results
FAIL=0
TEST_RESULTS=""

echo "=========================================="
echo "🎭 SMOKE TEST - NgomeAI System"
echo "Time: $(date)"
echo "=========================================="

# TEST 1: WAHA Session WORKING (port 3002)
echo -n "[1/5] WAHA Session (port 3002) ... "
# Get API key from environment or use default
WAHA_KEY="${WAHA_API_KEY:-[REDACTED]}"
WAHA_STATUS=$(curl -s -H "X-Api-Key: $WAHA_KEY" http://localhost:3002/api/sessions/default 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
if [ "$WAHA_STATUS" = "WORKING" ]; then
    echo "✅ PASS (status: $WAHA_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}✅ Test 1: WAHA WORKING\n"
else
    echo "❌ FAIL (status: $WAHA_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}❌ Test 1: WAHA NOT WORKING (status: $WAHA_STATUS)\n"
    FAIL=1
fi

# TEST 2: Orchestrator port 3000 UP
echo -n "[2/5] Orchestrator (port 3000) ... "
ORCH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health || echo "000")
if [ "$ORCH_STATUS" = "200" ] || [ "$ORCH_STATUS" = "404" ]; then
    echo "✅ PASS (HTTP $ORCH_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}✅ Test 2: Orchestrator UP\n"
else
    echo "❌ FAIL (HTTP $ORCH_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}❌ Test 2: Orchestrator DOWN (HTTP: $ORCH_STATUS)\n"
    FAIL=1
fi

# TEST 3: Webhook /waha returns OK
echo -n "[3/5] Webhook /waha endpoint ... "
WEBHOOK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhook/waha -H "Content-Type: application/json" -d '{"event":"message","session":"default","payload":{"from":"6281234567890","body":"test"}}' || echo "000")
if [ "$WEBHOOK_STATUS" = "200" ]; then
    echo "✅ PASS (HTTP $WEBHOOK_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}✅ Test 3: Webhook OK\n"
else
    echo "❌ FAIL (HTTP $WEBHOOK_STATUS)"
    TEST_RESULTS="${TEST_RESULTS}❌ Test 3: Webhook FAILED (HTTP: $WEBHOOK_STATUS)\n"
    FAIL=1
fi

# TEST 4: DB chat_history insert successful
echo -n "[4/5] Database (chat_history insert) ... "
DB_TEST=$(PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d ngomeai -c "INSERT INTO chat_history(client_id, user_phone, role, message, is_sent) VALUES('test','6281234567890','user','smoke test',false) RETURNING id;" 2>&1 | grep -E "INSERT|ERROR" || echo "ERROR")
if echo "$DB_TEST" | grep -q "INSERT"; then
    echo "✅ PASS (insert successful)"
    TEST_RESULTS="${TEST_RESULTS}✅ Test 4: DB Insert OK\n"
    # Cleanup test data
    PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d ngomeai -c "DELETE FROM chat_history WHERE message='smoke test';" 2>/dev/null
else
    echo "❌ FAIL (insert failed)"
    TEST_RESULTS="${TEST_RESULTS}❌ Test 4: DB Insert FAILED\n"
    FAIL=1
fi

# TEST 5: AI reply generates (test ping)
echo -n "[5/5] AI Reply Generation ... "
AI_TEST=$(curl -s -X POST http://localhost:3000/webhook/waha \
  -H "Content-Type: application/json" \
  -d '{"event":"message","session":"default","payload":{"from":"6281234567890","to":"628212128386@c.us","body":"ping test smoke","messageId":"smoke-test-123"}}' \
  --max-time 35 2>&1 || echo "TIMEOUT")
if echo "$AI_TEST" | grep -q "OK"; then
    echo "✅ PASS (AI replied)"
    TEST_RESULTS="${TEST_RESULTS}✅ Test 5: AI Reply OK\n"
else
    echo "❌ FAIL (no reply or timeout)"
    TEST_RESULTS="${TEST_RESULTS}❌ Test 5: AI Reply FAILED\n"
    FAIL=1
fi

echo "=========================================="
echo "HASIL AKHIR:"
echo -e "$TEST_RESULTS"
echo "=========================================="

if [ $FAIL -eq 0 ]; then
    echo "🎉 SEMUA TEST LOL0S! Siap merge ke STABLE."
    exit 0
else
    echo "💥 ADA TEST YANG GAGAL! JANGAN merge, ROLLBACK dulu!"
    exit 1
fi
