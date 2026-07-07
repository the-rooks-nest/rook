#!/usr/bin/env python3
"""Tail /tmp/pi-traces.jsonl and print new messages as they appear.

Each JSONL line is a complete prompt sent to an LLM provider. This script
normalizes both DeepSeek-format and GPT-format log entries into a common
message stream, diffs consecutive lines, and pretty-prints only the delta.

IMPORTANT: The JSONL file interleaves log lines from ALL active sessions.
Run only ONE session at a time for accurate results; concurrent sessions
will produce garbled output.

On startup, reads the last JSONL line (most recent session state) and prints
all messages from it. Then tails new lines, printing only the delta.

Usage:
    tail-logs.py [--instructions] [--tools]

Options:
    --instructions   Pretty-print system instructions when first seen
    --tools          Pretty-print tool definitions (YAML style) when first seen
"""

import argparse
import json
import os
import sys
import time

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

LOG_FILE = os.environ.get("PI_TRACE_LOG", "/tmp/pi-traces.jsonl")

# ── terminal styling ─────────────────────────────────────────────────

BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
RESET = "\033[0m"


def term_width():
    try:
        return os.get_terminal_size().columns
    except (ValueError, OSError):
        return 80


def header(icon, label, color=CYAN):
    width = max(60, term_width() - 2)
    line = f"{icon} {label} "
    line = line + "─" * max(1, width - len(line) - len(icon) - 1)
    print(f"\n{color}{BOLD}{line}{RESET}")


def wrap(text, indent=0, width=None):
    if width is None:
        width = term_width() - 2
    prefix = " " * indent
    max_line = width - indent
    lines = []
    for para in text.split("\n"):
        if para == "":
            lines.append("")
            continue
        while len(para) > max_line:
            brk = para.rfind(" ", 0, max_line)
            if brk < 20:
                brk = max_line
            lines.append(prefix + para[:brk].rstrip())
            para = para[brk:].lstrip()
        if para:
            lines.append(prefix + para)
    return "\n".join(lines)


def shorten(text, max_len=300):
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"\n{DIM}... [truncated {len(text) - max_len} chars]{RESET}"


# ── normalizers ──────────────────────────────────────────────────────


def normalize_deepseek(payload):
    """Normalize a DeepSeek-format log entry into display messages."""
    msgs = []
    for m in payload.get("messages", []):
        role = m.get("role")
        content = m.get("content")

        if role == "system":
            msgs.append({"kind": "system", "content": content or ""})

        elif role == "user":
            if isinstance(content, list):
                texts = []
                for c in content:
                    if isinstance(c, dict) and "text" in c:
                        texts.append(c["text"])
                msgs.append({"kind": "user", "content": "\n".join(texts)})
            else:
                msgs.append({"kind": "user", "content": str(content or "")})

        elif role == "assistant":
            reasoning = m.get("reasoning_content")
            if reasoning:
                msgs.append({"kind": "reasoning", "content": reasoning})

            tool_calls = m.get("tool_calls")
            if tool_calls:
                for tc in tool_calls:
                    func = tc.get("function", {})
                    try:
                        args = json.loads(func.get("arguments", "{}"))
                    except (json.JSONDecodeError, TypeError):
                        args = {"_raw": func.get("arguments", "")}
                    msgs.append({
                        "kind": "tool_call",
                        "tool_name": func.get("name", "?"),
                        "tool_id": tc.get("id", ""),
                        "args": args,
                    })

            if content:
                msgs.append({"kind": "assistant", "content": content})

        elif role == "tool":
            msgs.append({
                "kind": "tool_response",
                "tool_id": m.get("tool_call_id", ""),
                "content": str(content or ""),
            })

    return msgs


def normalize_gpt(payload):
    """Normalize a GPT-format log entry into display messages."""
    msgs = []

    instructions = payload.get("instructions", "")
    if instructions:
        msgs.append({"kind": "system", "content": instructions})

    for m in payload.get("input", []):
        role = m.get("role")
        mtype = m.get("type", "")
        content = m.get("content", "")

        if isinstance(content, list):
            texts = []
            for c in content:
                if isinstance(c, dict) and "text" in c:
                    texts.append(c["text"])
                elif isinstance(c, str):
                    texts.append(c)
            content = "\n".join(texts)

        if role == "user":
            msgs.append({"kind": "user", "content": str(content or "")})

        elif role == "assistant" or (mtype == "message" and m.get("phase") == "final_answer"):
            msgs.append({"kind": "assistant", "content": str(content or "")})

        elif mtype == "reasoning":
            msgs.append({"kind": "reasoning", "content": str(content or "")})

        elif mtype == "function_call":
            name = m.get("name", "?")
            args_str = m.get("arguments", "{}")
            try:
                args = json.loads(args_str)
            except (json.JSONDecodeError, TypeError):
                args = {"_raw": args_str}
            msgs.append({
                "kind": "tool_call",
                "tool_name": name,
                "tool_id": m.get("call_id", ""),
                "args": args,
            })

        elif mtype == "function_call_output":
            msgs.append({
                "kind": "tool_response",
                "tool_id": m.get("call_id", ""),
                "content": str(m.get("output", "")),
            })

    return msgs


def normalize(payload):
    """Dispatch to the correct normalizer based on payload shape."""
    if "messages" in payload:
        return normalize_deepseek(payload)
    if "input" in payload:
        return normalize_gpt(payload)
    return []


def get_tools(payload):
    """Extract and normalize tool definitions."""
    tools = payload.get("tools", [])
    normalized = []
    for t in tools:
        if t.get("type") == "function" or "function" in t:
            func = t.get("function", t)
            normalized.append({
                "name": func.get("name", "?"),
                "description": func.get("description", ""),
                "parameters": func.get("parameters", {}),
            })
        elif "name" in t:
            normalized.append({
                "name": t.get("name", "?"),
                "description": t.get("description", ""),
                "parameters": t.get("parameters", {}),
            })
    return normalized


# ── display ──────────────────────────────────────────────────────────


def print_message(msg):
    """Pretty-print a single display message."""
    kind = msg["kind"]
    content = msg.get("content", "")

    if kind == "system":
        header("\U0001f4dc", "SYSTEM INSTRUCTIONS", MAGENTA)
        print(wrap(content))
        print(f"{MAGENTA}{'─' * min(60, term_width())}{RESET}")

    elif kind == "user":
        header("\U0001f464", "USER", GREEN)
        print(wrap(content))

    elif kind == "assistant":
        header("\U0001f916", "ASSISTANT", BLUE)
        print(wrap(content))

    elif kind == "reasoning":
        header("\U0001f9e0", "REASONING", DIM)
        print(wrap(shorten(content, 500)))

    elif kind == "tool_call":
        tool_name = msg.get("tool_name", "?")
        args = msg.get("args", {})
        header("\U0001f527", f"TOOL CALL: {tool_name}", YELLOW)
        for k, v in args.items():
            if k.startswith("_"):
                continue
            vstr = json.dumps(v, indent=2) if isinstance(v, (dict, list)) else str(v)
            if len(vstr) > 200:
                vstr = vstr[:200] + f" {DIM}...{RESET}"
            print(f"  {BOLD}{k}{RESET}: {vstr}")

    elif kind == "tool_response":
        header("\U0001f4cb", "TOOL RESPONSE", YELLOW)
        print(wrap(shorten(content, 2000)))


def print_tools(tools):
    """Pretty-print tool definitions."""
    header("\U0001f6e0\ufe0f", "TOOLS", CYAN)
    if HAS_YAML:
        yaml_str = yaml.dump(
            tools, default_flow_style=False, sort_keys=False, width=min(100, term_width() - 4)
        )
        print(wrap(yaml_str))
    else:
        for t in tools:
            print(f"\n  {BOLD}{t['name']}{RESET}")
            print(f"  {DIM}{wrap(t.get('description', ''), indent=2)}{RESET}")


# ── tail loop ────────────────────────────────────────────────────────


def read_last_line(path):
    """Read the last non-empty line from the log file.

    The log is trimmed to ~100 lines so reading the whole file is fine.
    """
    with open(path, "r") as f:
        lines = [l.strip() for l in f if l.strip()]
    return lines[-1] if lines else None


def main():
    parser = argparse.ArgumentParser(description="Tail pi-traces JSONL and show message deltas")
    parser.add_argument("--instructions", action="store_true", help="Show system instructions only")
    parser.add_argument("--tools", action="store_true", help="Show tool definitions only")
    args = parser.parse_args()

    mode = "messages"
    if args.instructions:
        mode = "instructions"
    elif args.tools:
        mode = "tools"

    prev_msgs = []
    last_instruction_hash = None
    last_tools_hash = None

    # Wait for log file to exist
    print(f"{DIM}Waiting for {LOG_FILE}...{RESET}", file=sys.stderr)
    while not os.path.exists(LOG_FILE):
        time.sleep(0.5)

    # ── startup: read the last line to seed current state ──
    last_line = read_last_line(LOG_FILE)
    startup_payload = None
    if last_line:
        try:
            startup_payload = json.loads(last_line)
            curr_msgs = normalize(startup_payload)
        except json.JSONDecodeError:
            curr_msgs = []

        if mode == "instructions":
            sys_msgs = [m for m in curr_msgs if m["kind"] == "system"]
            if sys_msgs:
                print_message(sys_msgs[0])
                last_instruction_hash = hash(sys_msgs[0]["content"])
        elif mode == "tools":
            tools = get_tools(startup_payload)
            if tools:
                print_tools(tools)
                last_tools_hash = hash(json.dumps(tools, sort_keys=True, default=str))
        else:
            # mode == "messages": print all messages from the last line
            for msg in curr_msgs:
                print_message(msg)

        prev_msgs = curr_msgs

    # ── tail new lines (messages mode only) ──
    if mode != "messages":
        return

    with open(LOG_FILE, "r") as f:
        f.seek(0, os.SEEK_END)
        print(f"{DIM}Tailing {LOG_FILE}{RESET}", file=sys.stderr)

        while True:
            line = f.readline()
            if not line:
                time.sleep(0.1)
                continue

            line = line.strip()
            if not line:
                continue

            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue

            curr_msgs = normalize(payload)

            if mode == "instructions":
                sys_msgs = [m for m in curr_msgs if m["kind"] == "system"]
                if sys_msgs:
                    ihash = hash(sys_msgs[0]["content"])
                    if ihash != last_instruction_hash:
                        print_message(sys_msgs[0])
                        last_instruction_hash = ihash

            elif mode == "tools":
                tools = get_tools(payload)
                if tools:
                    thash = hash(json.dumps(tools, sort_keys=True, default=str))
                    if thash != last_tools_hash:
                        print_tools(tools)
                        last_tools_hash = thash

            else:
                # mode == "messages": show delta
                if prev_msgs:
                    max_common = min(len(prev_msgs), len(curr_msgs))
                    for i in range(max_common):
                        if prev_msgs[i] != curr_msgs[i]:
                            print_message(curr_msgs[i])
                    for i in range(len(prev_msgs), len(curr_msgs)):
                        print_message(curr_msgs[i])

            prev_msgs = curr_msgs


if __name__ == "__main__":
    main()
