#!/bin/bash

# Konfigurasi
BOT_TOKEN="8671241755:AAEaN_29XipQ51sK_YKjdNLdxnyoJFYP43M"
CHAT_ID="1792051357"
API_KEY="e0e4b99a236f19c95c0f8b33ebc9952a5367a48dbabf2b47e5e715943fdb3ddf"
LOG_FILE="/tmp/qr-monitor.log"

# Array ports dan customer numbers
declare -a PORTS=(3003 3004 3005 3006 3007 3008)
declare -a CUSTOMERS=(1 2 3 4 5 6)

# Fungsi kirim QR ke Telegram
send_qr() {
    local port=$1
    local customer=$2
    local caption="$3"
    local qr_file="/tmp/qr-cust-$(printf '%03d' $customer)-$(date +%s).png"
    
    # Ambil QR (PNG binary)
    curl -s -H "X-Api-Key: $API_KEY" "http://localhost:$port/api/default/auth/qr" -o "$qr_file"
    
    # Cek file valid (PNG)
    if file "$qr_file" | grep -q "PNG"; then
        # Kirim ke Telegram
        result=$(curl -s -F chat_id="$CHAT_ID" -F photo="@$qr_file" -F caption="$caption" "https://api.telegram.org/bot$BOT_TOKEN/sendPhoto")
        if echo "$result" | grep -q '"ok":true'; then
            echo "[$(date '+%H:%M:%S')] ✅ Customer $customer: QR sent" >> "$LOG_FILE"
            return 0
        else
            echo "[$(date '+%H:%M:%S')] ❌ Customer $customer: Failed to send QR" >> "$LOG_FILE"
            return 1
        fi
    else
        echo "[$(date '+%H:%M:%S')] ⚠️ Customer $customer: Invalid QR (not PNG)" >> "$LOG_FILE"
        return 1
    fi
}

# Fungsi cek status session
check_status() {
    local port=$1
    curl -s -H "X-Api-Key: $API_KEY" "http://localhost:$port/api/sessions/default" | \
        python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','UNKNOWN'))" 2>/dev/null
}

# Fungsi dapatkan QR hash (buat cek perubahan)
get_qr_hash() {
    local port=$1
    curl -s -H "X-Api-Key: $API_KEY" "http://localhost:$port/api/default/auth/qr" | md5sum | cut -d' ' -f1
}

echo "=== QR Monitor Started at $(date) ===" > "$LOG_FILE"
echo "Monitoring 6 customers (ports 3003-3008)" >> "$LOG_FILE"
echo "Chat ID: $CHAT_ID" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Inisialisasi: Kirim QR pertama kali
echo "Sending initial QR codes..."
for i in {0..5}; do
    port=${PORTS[$i]}
    customer=${CUSTOMERS[$i]}
    send_qr $port $customer "📱 QR Code Customer $customer (Port $port) - Scan dengan WhatsApp HP!"
    sleep 1
done

echo "Initial QR sent. Starting monitor loop..." >> "$LOG_FILE"

# Monitor loop (timeout 10 menit = 20 iterasi @ 30s)
MAX_ATTEMPTS=20
for attempt in $(seq 1 $MAX_ATTEMPTS); do
    echo "[$(date '+%H:%M:%S')] Check $attempt/$MAX_ATTEMPTS..." >> "$LOG_FILE"
    
    all_done=true
    
    for i in {0..5}; do
        port=${PORTS[$i]}
        customer=${CUSTOMERS[$i]}
        
        status=$(check_status $port)
        
        if [ "$status" = "WORKING" ]; then
            echo "[$(date '+%H:%M:%S')] ✅ Customer $customer: CONNECTED!" >> "$LOG_FILE"
            curl -s -F chat_id="$CHAT_ID" -F text="✅ Customer $customer BERHASIL terhubung! WhatsApp sudah aktif (Port $port)." "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" > /dev/null
            # Mark as done (skip next checks)
            PORTS[$i]=""
        elif [ "$status" = "SCAN_QR_CODE" ]; then
            all_done=false
            # Cek apakah QR berubah (expired)
            new_hash=$(get_qr_hash $port)
            old_hash_var="QR_HASH_$customer"
            old_hash=${!old_hash_var}
            
            if [ "$new_hash" != "$old_hash" ]; then
                echo "[$(date '+%H:%M:%S')] 🔄 Customer $customer: QR expired, sending new one..." >> "$LOG_FILE"
                send_qr $port $customer "🔄 QR Code Customer $customer (UPDATE - yang lama expired) - Scan ulang!"
                declare "QR_HASH_$customer=$new_hash"
            fi
        else
            echo "[$(date '+%H:%M:%S')] ⚠️ Customer $customer: Status = $status" >> "$LOG_FILE"
            all_done=false
        fi
    done
    
    # Cek apakah semua sudah terhubung
    if [ "$all_done" = "true" ]; then
        echo "[$(date '+%H:%M:%S')] === ALL CUSTOMERS CONNECTED ===" >> "$LOG_FILE"
        curl -s -F chat_id="$CHAT_ID" -F text="🎉 Semua customer BERHASIL terhubung!" "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" > /dev/null
        break
    fi
    
    # Tunggu 30 detik sebelum cek lagi
    sleep 30
done

if [ "$attempt" = "$MAX_ATTEMPTS" ]; then
    echo "[$(date '+%H:%M:%S')] ⏳ Timeout (10 menit). Some customers may not be connected." >> "$LOG_FILE"
    curl -s -F chat_id="$CHAT_ID" -F text="⏳ Monitor timeout (10 menit). Cek status manual dengan /status." "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" > /dev/null
fi

echo "=== Monitor ended at $(date) ===" >> "$LOG_FILE"
