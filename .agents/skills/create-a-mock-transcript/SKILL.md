# Create a Mock Transcript

This skill teaches you how to create mock transcript files for the MockAgent. The MockAgent replays pre-recorded conversations, ignoring user input and instead playing back the next "turn" from the transcript. This is useful for testing the UI, error surfacing, tool rendering, and streaming behavior without a real AI backend.

## Where it saves

Always save the transcript to `.var/example_transcript.json` in the repo root. The MockAgent reads from this path. If the file doesn't exist when the MockAgent starts, it errors with a message telling the user to use this skill.

## Transcript format

The file is a JSON array of "turns". Each turn is an object with a `timestamp` and an array of `events`:

```json
[
  {
    "timestamp": "2026-07-05T12:00:00Z",
    "events": [
      { "type": "thinking",      "text": "Let me think about what the user asked..." },
      { "type": "agent_message", "text": "Here's what I found." },
      { "type": "tool_call",     "id": "call_1", "name": "bash", "input": { "command": "ls" } },
      { "type": "tool_result",   "id": "call_1", "output": "file1.txt\nfile2.txt" },
      { "type": "agent_message", "text": "There are two files in the directory." }
    ]
  },
  {
    "timestamp": "2026-07-05T12:01:00Z",
    "events": [
      { "type": "thinking",      "text": "The user wants to know about file1.txt." },
      { "type": "tool_call",     "id": "call_2", "name": "read", "input": { "path": "file1.txt" } },
      { "type": "tool_result",   "id": "call_2", "output": "Hello, world!\n" },
      { "type": "agent_message", "text": "file1.txt contains \"Hello, world!\"." }
    ]
  }
]
```

### Event types

| Type | Fields | Description |
|---|---|---|
| `thinking` | `text` (string) | Agent's internal reasoning, rendered in the thinking block |
| `agent_message` | `text` (string) | Text response shown to the user |
| `tool_call` | `id` (string), `name` (string), `input` (any) | Tool invocation. `id` must match a `tool_result` later in the same turn |
| `tool_result` | `id` (string), `output` (string) | Result of a tool call. `id` must match a preceding `tool_call` |

### Rules

- **Tool call and tool result IDs must match within a turn.** Use simple sequential IDs like `call_1`, `call_2`, etc.
- **Tool input** can be a string, object, or any JSON value. Objects are JSON-stringified for streaming. Strings are streamed as-is.
- **Each turn is consumed per user message.** The user must send a message (any text) to advance to the next turn. The mock agent ignores the actual content of what the user types.
- **No user messages in the transcript.** The transcript only contains agent-side events (thinking, messages, tool calls, and tool results).
- **Timestamps should be ISO 8601** but are informational only — they don't affect replay timing.

## Creating a transcript from pi-traces.jsonl

If `.var/pi-traces.jsonl` exists, you can extract a simplified transcript from real agent traces. Each line in that file is a full LLM provider request with a `messages` array in OpenAI format.

The messages array alternates between:
- `role: "user"` — user prompts (skip these — they mark turn boundaries)
- `role: "assistant"` — agent responses with optional `reasoning_content` (→ thinking) and `tool_calls` (→ tool_call events)
- `role: "tool"` — tool results with `tool_call_id` and `content` (→ tool_result events)

**Extraction process:**

1. Read `.var/pi-traces.jsonl` line by line
2. For each line, parse the JSON and look at the `messages` array
3. Group messages into turns separated by `role: "user"` messages
4. For each turn, create events:
   - `reasoning_content` on assistant messages → `{ "type": "thinking", "text": "..." }`
   - Text `content` on assistant messages (when not null) → `{ "type": "agent_message", "text": "..." }`
   - `tool_calls` on assistant messages → `{ "type": "tool_call", "id": "...", "name": "...", "input": {...} }`
   - Tool messages → `{ "type": "tool_result", "id": "...", "output": "..." }`
5. Use the `tool_call.id` from the assistant message and `tool_call_id` from the tool message to match them
6. Write the result to `.var/example_transcript.json`

## Creating a transcript by hand

You can also construct a transcript manually. Write valid JSON conforming to the schema above. Make sure:
- The top-level value is an array
- Each element has `timestamp` (string) and `events` (array)
- Each event has the correct `type` and required fields
- Tool call/result IDs match within each turn

## After creating the transcript

Start (or restart) the server, then begin a session with the MockAgent. Each message you send will advance through the transcript turns. When all turns are exhausted, the agent stops responding.
