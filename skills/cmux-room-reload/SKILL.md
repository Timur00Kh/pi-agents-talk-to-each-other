---
name: cmux-room-reload
description: Reload a worker pi agent or create a new session, then reconnect it to its room, using cmux terminal automation. Bypasses the sendUserMessage slash-command limitation.
---

# cmux Room Reload

Reload a worker pi agent and reconnect it to its room, using cmux terminal automation.

## When to use

When you need to reload a worker agent (update extension code, pick up changes) or create a new session for it, and reconnect it to the same room. This bypasses the `sendUserMessage` limitation where pi skips slash commands from extension-injected messages.

## Prerequisites

- Both agents run in cmux on the same machine
- cmux CLI is available (`cmux` command works)
- Both agents are in the same room (via `pi-agents-talk-to-each-other` extension)

## Steps

### 1. Ask the worker agent for its cmux surface ID

Use `room_send_message` to ask the target agent:

```
room_send_message to="<agent-id>" message="Reply with the exact value of your CMUX_SURFACE_ID environment variable. Run: echo $CMUX_SURFACE_ID"
```

**Do NOT sleep or poll for the answer.** The worker agent replies via room messages (delivered as followUp). Just end your turn — the reply will arrive as a room message automatically.

The worker agent will run `echo $CMUX_SURFACE_ID` and reply with its surface ID (a UUID like `13960A68-326F-4B37-A4B6-7A7EA258CD7E`).

### 2. Reload or create new session + reconnect

Once you receive the surface ID, run in a single bash command.

**Reload** (reload extensions, keep session):

```bash
cmux send --surface "<surface-id>" "/reload
" && sleep 5 && cmux send --surface "<surface-id>" "/room connect <room-name>
"
```

**New session** (fresh context, same process):

```bash
cmux send --surface "<surface-id>" "/new
" && sleep 5 && cmux send --surface "<surface-id>" "/room connect <room-name>
"
```

Examples:
```bash
# Reload
cmux send --surface "13960A68-326F-4B37-A4B6-7A7EA258CD7E" "/reload
" && sleep 5 && cmux send --surface "13960A68-326F-4B37-A4B6-7A7EA258CD7E" "/room connect dev
"

# New session
cmux send --surface "13960A68-326F-4B37-A4B6-7A7EA258CD7E" "/new
" && sleep 5 && cmux send --surface "13960A68-326F-4B37-A4B6-7A7EA258CD7E" "/room connect dev
"
```

### 3. Verify

Use `room_list_agents` to confirm both agents are in the room.

## Alternative: discover without asking

If the worker agent is unresponsive or you need to find surfaces quickly:

```bash
bash ~/.pi/agent/skills/cmux-room-reload/cmux-room-reload.sh discover
```

This lists all cmux surfaces with `room:` in their status bar. Identify the worker by excluding your own surface (check `echo $CMUX_SURFACE_ID`).

## Important: do not sleep between turns

When asking the worker agent for its surface ID via `room_send_message`, the reply comes as a room message (followUp delivery). Do NOT use `sleep` or poll for the reply. End your turn and the reply will arrive automatically as an interrupting room message.

The only `sleep` in this flow is inside the single bash command between `/reload` (or `/new`) and `/room connect` (5 seconds for the command to complete).

## How it works

- `cmux send` sends keyboard input to the target terminal
- pi processes interactive keyboard input with `expandPromptTemplates: true`, so slash commands work
- After reload or new session, the agent loses its room connection (auto-connect is off by default)
- The second `cmux send` reconnects it to the room

## Limitations

- Only works when both agents run in cmux on the same machine
- The worker agent must be idle to process the `room_send_message` and reply
- cmux must be in automation mode (not `cmuxOnly`)