#!/bin/bash
# cmux-room-reload — reload a worker agent and reconnect it to its room
# Usage:
#   cmux-room-reload discover              — list surfaces with room status
#   cmux-room-reload <surface-id> <room>   — reload + reconnect
# Example:
#   cmux-room-reload discover
#   cmux-room-reload surface:13 dev

set -euo pipefail

CMD="${1:-}"

if [ "$CMD" = "discover" ] || [ -z "$CMD" ]; then
  echo "Surfaces with room status:"
  echo "---"
  cmux tree 2>/dev/null | grep "surface" | while read -r line; do
    ref=$(echo "$line" | grep -oE 'surface:[0-9]+')
    if [ -n "$ref" ]; then
      status=$(cmux capture-pane --surface "$ref" --lines 3 2>/dev/null | tail -1)
      if echo "$status" | grep -q "room:"; then
        room=$(echo "$status" | grep -oE 'room:[a-zA-Z0-9_-]+' | head -1)
        ctrl=$(echo "$status" | grep -q '\[control\]' && echo " [control]" || echo "")
        echo "$ref  $room$ctrl"
      fi
    fi
  done
  echo "---"
  echo "Usage: cmux-room-reload <surface-id> <room-name>"
  exit 0
fi

SURFACE="$1"
ROOM="${2:-dev}"

echo "Reloading $SURFACE and reconnecting to room:$ROOM..."
cmux send --surface "$SURFACE" "/reload
" && sleep 5 && cmux send --surface "$SURFACE" "/room connect $ROOM
"
echo "Done. Verify with room_list_agents."