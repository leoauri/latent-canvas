# /// script
# requires-python = ">=3.11"
# ///
"""Commit hooks: append the human prompts behind the staged changes to the commit message.

  prepare-commit-msg: commit_prompts.py prepare <msg-file> [source]
  post-commit:        commit_prompts.py commit

Prompts come from Claude Code transcripts of this repo and from the page chat log
(.redaw/chat.jsonl, written by the dev server). Candidates are the prompts written since
the last run, plus prompts carried over because their work was still uncommitted.
Sonnet picks which candidates contributed to the staged diff (copied here verbatim, it
only returns ids), which still belong to uncommitted work (carried to the next commit),
and, only if needed, agent decisions that explain a change.

State lives in .git/commit-prompts/: pending.json is the carried-over set plus the scan
cursor; prepare writes next.json, and post-commit promotes it, so an aborted commit
changes nothing.

prepare aborts the commit on any error (missing `claude`, a failed Sonnet call, …), so a
broken setup doesn't go unnoticed. Rebases, cherry-picks and reverts are skipped. Skip one
commit with SKIP_PROMPT_HOOK=1.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if sys.version_info < (3, 11):
    sys.exit("commit-prompts: needs Python 3.11+, commit aborted. Skip with SKIP_PROMPT_HOOK=1.")

HEADER = "Human prompts:"
MAX_DIFF = 60_000
MAX_REST = 30_000
MAX_AGENT_TEXT = 1_500
TIMEOUT = 180


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def iso_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


# ---- sources


def transcript_dirs(root):
    """Claude Code sessions started in the repo root or any subdirectory of it."""
    mangled = re.sub(r"[^A-Za-z0-9]", "-", str(root))
    return [d for base in config_dirs() for d in (base / "projects").glob(mangled + "*")
            if d.name == mangled or d.name.startswith(mangled + "-")]


def config_dirs():
    """~/.claude, alternate config dirs like ~/.claude-work, and $CLAUDE_CONFIG_DIR."""
    home = Path.home()
    dirs = [home / ".claude", *sorted(home.glob(".claude-*"))]
    if env := os.environ.get("CLAUDE_CONFIG_DIR"):
        dirs.append(Path(env).expanduser())
    seen, out = set(), []
    for d in dirs:
        r = d.resolve()
        if r not in seen and (d / "projects").is_dir():
            seen.add(r)
            out.append(d)
    return out


def prompt_text(content):
    """The human-typed text of a transcript user entry, or None for tool results and the like."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if block.get("type") == "text":
            parts.append(block["text"])
        elif block.get("type") == "image":
            parts.append("[image]")
        else:
            return None  # tool_result etc.: not typed by the human
    return "\n".join(parts) or None


def is_noise(text):
    s = text.lstrip()
    return s.startswith(("<local-command-", "<command-name>", "<command-message>", "Caveat: ", "[Request interrupted",
                        "<task-notification>"))


def from_transcripts(root, since):
    for d in transcript_dirs(root):
        for f in sorted(d.glob("*.jsonl")):
            if f.stat().st_mtime < since:
                continue
            for line in f.read_text().splitlines():
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (e.get("isSidechain") or e.get("isMeta") or e.get("isCompactSummary")
                        or e.get("isVisibleInTranscriptOnly") or "timestamp" not in e):
                    continue
                ts = iso_ts(e["timestamp"])
                if ts <= since:
                    continue
                msg = e.get("message") or {}
                src = "claude-code:" + f.stem[:8]
                if e.get("type") == "user" and msg.get("role") == "user":
                    text = prompt_text(msg.get("content", ""))
                    if text and text.strip() and not is_noise(text):
                        yield "human", ts, src, text
                elif e.get("type") == "assistant":
                    for block in msg.get("content") or []:
                        if block.get("type") == "text" and block["text"].strip():
                            yield "agent", ts, src, block["text"]


def from_page_chat(root, since):
    log = root / ".redaw" / "chat.jsonl"
    if not log.exists() or log.stat().st_mtime < since:
        return
    for line in log.read_text().splitlines():
        try:
            e = json.loads(line)
            ts = iso_ts(e["ts"])
        except (json.JSONDecodeError, KeyError, ValueError):
            continue
        if ts > since and e.get("text", "").strip():
            yield ("human" if e.get("role") == "human" else "agent"), ts, "page-chat", e["text"]


def collect(root, since):
    prompts, agent = [], []
    for kind, ts, src, text in [*from_transcripts(root, since), *from_page_chat(root, since)]:
        if kind == "human":
            prompts.append({"ts": ts, "source": src, "text": text})
        else:
            agent.append({"ts": ts, "source": src, "text": text[:MAX_AGENT_TEXT]})
    return prompts, agent


# ---- ledger


def sequencer_in_progress():
    """A rebase, cherry-pick or revert replaying existing commits, whose messages stay as they are."""
    return any(Path(git("rev-parse", "--git-path", p).strip()).exists()
               for p in ("rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"))


def state_dir():
    return Path(git("rev-parse", "--git-path", "commit-prompts").strip()).resolve()


def load_pending():
    f = state_dir() / "pending.json"
    if f.exists():
        try:
            return json.loads(f.read_text())
        except json.JSONDecodeError:
            pass
    return None


# ---- Sonnet

SCHEMA = {
    "type": "object",
    "properties": {
        "prompt_ids": {"type": "array", "items": {"type": "integer"}},
        "keep_ids": {"type": "array", "items": {"type": "integer"}},
        "decisions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["prompt_ids", "keep_ids", "decisions"],
}


def ask_sonnet(diff, rest, message, prompts, agent):
    timeline = sorted(
        [{"ts": p["ts"], "s": f"[HUMAN PROMPT id={p['id']} via {p['source']}]\n{p['text']}"} for p in prompts]
        + [{"ts": a["ts"], "s": f"[AGENT via {a['source']}]\n{a['text']}"} for a in agent],
        key=lambda x: x["ts"],
    )
    task = f"""You annotate a git commit with the human prompts that led to it.

Below are the staged diff (what this commit contains), the changes that stay uncommitted,
the draft commit message, and a timeline of human prompts and agent replies from coding
sessions. Some prompts may be older than the agent replies shown; they were carried over
from earlier commits because their work was not committed yet.

1. prompt_ids: ids of every HUMAN PROMPT that contributed to the staged diff (asked for the
   changes, shaped them, corrected them, or gave requirements they implement). Leave out
   prompts that only asked questions or concerned other work.
2. keep_ids: ids of HUMAN PROMPTs that contributed to the uncommitted changes. A prompt can be
   in both lists if its work is split across staged and uncommitted changes.
3. decisions: usually empty. Only if the reason for a change in the staged diff cannot be
   understood from the selected prompts, add one short sentence per agent decision that explains it.

<draft_commit_message>
{message}
</draft_commit_message>

<staged_diff>
{diff}
</staged_diff>

<uncommitted_changes>
{rest or "(none)"}
</uncommitted_changes>

<timeline>
{chr(10).join(x["s"] for x in timeline)}
</timeline>
"""
    out = subprocess.run(
        ["claude", "-p", "--model", "sonnet", "--output-format", "json", "--no-session-persistence",
         "--tools", "", "--json-schema", json.dumps(SCHEMA)],
        input=task, capture_output=True, text=True, timeout=TIMEOUT, check=True,
        cwd=Path.home(),  # keep the repo's own settings and hooks out of this run
    ).stdout
    result = json.loads(out)
    data = result.get("structured_output")
    if data is None:
        text = result.get("result", "")
        data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    return data


# ---- message


def quote(text):
    return "\n".join(("> " + line).rstrip() for line in text.strip().splitlines())


def insert_section(message, addition):
    """Insert `addition` before git trailers (Co-Authored-By etc.) and comment lines."""
    lines = message.rstrip("\n").split("\n")
    cut = len(lines)
    while cut > 0 and (lines[cut - 1].startswith("#") or not lines[cut - 1].strip()):
        cut -= 1
    body, tail = lines[:cut], lines[cut:]
    t = len(body)
    while t > 0 and re.match(r"^[A-Za-z-]+: ", body[t - 1]):
        t -= 1
    if 0 < t < len(body) and not body[t - 1].strip():
        head, trailers = body[: t - 1], body[t - 1:]
    else:
        head, trailers = body, []
    new = "\n".join(head).rstrip() + "\n\n" + addition + "\n" + "\n".join(trailers + tail)
    return new.rstrip("\n") + "\n"


def uncommitted_changes():
    rest = git("diff")
    untracked = git("ls-files", "--others", "--exclude-standard").strip()
    if untracked:
        rest += "\nUntracked files:\n" + untracked
    return rest[:MAX_REST]


# ---- hooks


def prepare(msg_file, source):
    sd = state_dir()
    (sd / "next.json").unlink(missing_ok=True)  # a stale proposal from an aborted commit
    if os.environ.get("SKIP_PROMPT_HOOK") or source in ("merge", "squash", "commit") or sequencer_in_progress():
        return
    msg_path = Path(msg_file)
    message = msg_path.read_text()
    if HEADER in message:
        return
    diff = git("diff", "--cached")[:MAX_DIFF]
    if not diff.strip():
        return

    root = Path(git("rev-parse", "--show-toplevel").strip())
    now = time.time()
    pending = load_pending()
    if pending is not None:
        since, carried = pending["cursor"], pending["prompts"]
    else:
        try:
            since = int(git("log", "-1", "--format=%ct").strip())
        except subprocess.CalledProcessError:
            since = 0  # first commit
        carried = []
    fresh, agent = collect(root, since)
    prompts = [{**p, "id": i + 1} for i, p in enumerate(sorted(carried + fresh, key=lambda p: p["ts"]))]

    data = {"prompt_ids": [], "keep_ids": [], "decisions": []}
    if prompts:
        if not shutil.which("claude"):
            raise RuntimeError("`claude` (Claude Code CLI) not found on PATH")
        print(f"commit-prompts: asking Sonnet about {len(prompts)} prompt(s)…", file=sys.stderr)
        draft = "\n".join(l for l in message.splitlines() if not l.startswith("#"))
        data = ask_sonnet(diff, uncommitted_changes(), draft, prompts, agent)

    by_id = {p["id"]: p for p in prompts}
    pick = lambda key: [by_id[i] for i in sorted(set(data.get(key, []))) if i in by_id]
    chosen, kept = pick("prompt_ids"), pick("keep_ids")
    decisions = [d.strip() for d in data.get("decisions", []) if d.strip()]

    sd.mkdir(parents=True, exist_ok=True)
    strip = lambda p: {k: p[k] for k in ("ts", "source", "text")}
    (sd / "next.json").write_text(json.dumps({"cursor": now, "prompts": [strip(p) for p in kept]}, indent=1))
    if kept:
        print(f"commit-prompts: carrying {len(kept)} prompt(s) to a later commit", file=sys.stderr)

    section = []
    if chosen:
        section.append(HEADER + "\n\n" + "\n\n".join(quote(p["text"]) for p in chosen))
    if decisions:
        section.append("Agent decisions:\n\n" + "\n".join(f"- {d}" for d in decisions))
    if section:
        msg_path.write_text(insert_section(message, "\n\n".join(section)))


def commit():
    sd = state_dir()
    nxt = sd / "next.json"
    if nxt.exists():
        nxt.replace(sd / "pending.json")


if __name__ == "__main__":
    cmd = sys.argv[1]
    try:
        if cmd == "prepare":
            prepare(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
        elif cmd == "commit":
            commit()
    except Exception as e:
        if cmd != "prepare":  # post-commit can't undo the commit anyway
            print(f"commit-prompts: skipped ({type(e).__name__}: {e})", file=sys.stderr)
            sys.exit(0)
        if isinstance(e, subprocess.CalledProcessError):
            what = f"`{e.cmd[0]}` exited with status {e.returncode}\n{e.stderr or ''}"
        else:
            what = f"{type(e).__name__}: {e}"
        print(f"commit-prompts: {what}".rstrip(), file=sys.stderr)
        print("commit-prompts: commit aborted. Fix the above, or skip with SKIP_PROMPT_HOOK=1.", file=sys.stderr)
        sys.exit(1)
