# pi-agents-talk-to-each-other

A small [Pi](https://github.com/earendil-works/pi) package that lets multiple local Pi agents join the same room, see each other's status, and send messages/tasks to each other.

The first version is intentionally simple: it uses a local file-based room bus under `~/.pi/agent/rooms/`, so no daemon, sockets, database, or network server is required.

## Features

- Local rooms shared by all Pi processes on the same machine.
- Slash command for humans: `/room ...`.
- LLM-callable tools:
  - `room_whoami`
  - `room_list_agents`
  - `room_send_message`
  - `room_control_agent`
- Heartbeat/status for each agent:
  - agent id
  - idle/busy/tool/offline
  - current tool name and masked preview
  - cwd
  - model
  - current context usage when available
  - rough token totals when available
- Follow-up delivery: if the target agent is busy, the received message is queued as a follow-up user message.
- Basic session control messages: `compact`, `reload`, `new_session`.

## Installation

From GitHub:

```bash
pi install git:github.com/Timur00Kh/pi-agents-talk-to-each-other
```

For local development from this checkout:

```bash
pi install /absolute/path/to/pi-agents-talk-to-each-other
# or one-off:
pi -e /absolute/path/to/pi-agents-talk-to-each-other
```

After installing, restart Pi or run `/reload` in existing Pi sessions.

## Quick start

Open two or more Pi sessions and connect them to the same room:

```text
/room connect dev
```

`/room connect` only connects the current Pi process. New Pi sessions do not auto-connect by default.

If you explicitly want future Pi sessions to auto-connect, use either:

```text
/room connect dev --default
# or
/room default dev
```

List agents:

```text
/room list
```

Show your own id/status:

```text
/room whoami
```

Send a manual message:

```text
/room send agent-myhost-12345 Please inspect the failing tests. Reply to my agent id when done.
```

Leave the current room:

```text
/room leave
```

## Slash commands

```text
/room connect <room> [--default]
/room create <room> [--default]
/room leave [--keep-default]
/room list [--stale]
/room send <agent-id> <message>
/room whoami
/room default <room|off>
/room status
```

## Tools available to the model

### `room_whoami`

Returns this agent's room identity and debug info.

Use it when an agent needs to include its own id in a delegated task or reply instruction.

### `room_list_agents`

Lists active agents in the current room.

Example output:

```text
agent-macbook-41841 idle ctx:31% model:openai/gpt-5 cwd:/repo
agent-macbook-42109 tool tool:bash ctx:55% model:anthropic/claude cwd:/repo {"command":"npm test"}
```

### `room_send_message`

Sends a prompt-like user message to another agent by id.

Recommended delegation pattern:

> Do X. My agent id is `agent-...`. When done or blocked, call `room_send_message` back to me with the result.

### `room_control_agent`

Queues one of these actions on another agent:

- `compact`
- `reload`
- `new_session`

Use sparingly. Normal coordination should use `room_send_message`.

## Storage layout

Runtime state is stored locally:

```text
~/.pi/agent/rooms/
  config.json
  <room>/
    agents/
      <agent-id>.json
    inbox/
      <agent-id>/
        <message-id>.json
    events.jsonl
```

Message files are deleted after delivery. `agents/*.json` and `events.jsonl` are debug/runtime files and can be deleted if needed.

## Safety notes

- This is local-machine coordination only; it does not authenticate senders.
- Any Pi process that can write to `~/.pi/agent/rooms/<room>` can send messages/control events.
- Tool argument previews are masked/truncated, but do not treat room debug files as a secure audit log.
- The extension never reads `.env` files or credentials by itself.

## Current limitations

- File polling instead of a socket daemon.
- No role model yet; all agents in a room have equal rights.
- No tree/fork orchestration yet.
- No guaranteed exactly-once delivery across process crashes.

These are deliberate MVP trade-offs to keep the extension easy to test and evolve.
