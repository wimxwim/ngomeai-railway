#!/bin/bash
# Keep-alive script untuk server (monitor setiap 30 detik)

LOG_FILE="/tmp/keepalive.log"
PORT=3010
MAX_RESTARTS=5
RESTART_COUNT=0

while true; do
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  # Check if server is responding
  HEALTH=$(curl -s http://localhost:$PORT/health 2>/dev/null)
  
  if [[ $HEALTH == *"ok"* ]]; then
    echo "[$TIMESTAMP] ✓ Server OK" >> $LOG_FILE
  else
    echo "[$TIMESTAMP] ✗ Server DOWN - attempting restart" >> $LOG_FILE
    
    if [ $RESTART_COUNT -lt $MAX_RESTARTS ]; then
      # Kill existing processes
      lsof -i :$PORT -t 2>/dev/null | xargs kill -9 2>/dev/null
      sleep 2
      
      # Restart server
      cd /home/ngome/Documents/chatbot/chatbot/ngomeai-codeengine/codeengine-node-postgres
      nohup npm start >> /tmp/server.log 2>&1 &
      
      RESTART_COUNT=$((RESTART_COUNT + 1))
      echo "[$TIMESTAMP] Restart attempt $RESTART_COUNT" >> $LOG_FILE
      sleep 5
    else
      echo "[$TIMESTAMP] ✗ Max restarts exceeded - manual intervention needed" >> $LOG_FILE
    fi
  fi
  
  # Print last line of keepalive log
  tail -1 $LOG_FILE
  
  sleep 30
done
