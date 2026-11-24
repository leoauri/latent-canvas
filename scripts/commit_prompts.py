# /// script
# requires-python = ">=3.11"
# ///
"""Commit hooks: append the human prompts behind the staged changes to the commit message.

  prepare-commit-msg: commit_prompts.py prepare <msg-file> [source]
  post-commit:        commit_prompts.py commit

Prompts come from Claude Code transcripts of this repo and from the page chat log
(.redaw/chat.jsonl, written by the dev server). Candidates are the prompts written since
the last run, plus prompts carried over because their work was still uncommitted.
Prompts are split into numbered sentences, and Sonnet picks the sentences that contributed
to the staged diff (copied here verbatim, it only returns ids; omissions are marked […]),
which prompts still belong to uncommitted or not yet started work (carried to the next
commit, together with the agent replies that proposed that work), and, only if needed,
agent decisions that explain a change. Quoted text goes through redact(): URL parameter
values, credentials and random-looking tokens become <redacted>, since commits may be pushed.

Page-chat turns made while a session was open (their log line names the session) worked on that
session's own code, which never reaches the working tree by itself. They are not candidates for
ordinary commits: they wait in a per-session pool until a commit promotes that session's code to
the base, which it says with a trailer `Promotes-session: <session doc url>` (one per session).
Then the session's pooled turns become candidates too; a quoted prompt leaves the pool, the rest
stays for later promotions.

State lives in .git/commit-prompts/: pending.json is the carried-over set (prompts and agent
replies), the session pools, plus the scan cursor; prepare writes next.json, and post-commit promotes it, so an aborted commit
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
PROMOTES = re.compile(r"^Promotes-session:[ \t]*(\S+)[ \t]*$", re.M)
POOL_MAX = 300  # per session and kind: older pooled turns are dropped
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
                        "<task-notification>",
                        # compaction summaries; isCompactSummary is not set on every Claude Code version
                        "This session is being continued from a previous conversation"))


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
            yield ("human" if e.get("role") == "human" else "agent"), ts, "page-chat", e["text"], e.get("session")


def collect(root, since):
    """-> (prompts, agent, pooled): pooled maps a session doc to {"prompts", "agent"} of its page-chat turns."""
    prompts, agent, pooled = [], [], {}
    for kind, ts, src, text, *session in [*from_transcripts(root, since), *from_page_chat(root, since)]:
        session = session[0] if session else None
        if kind == "human":
            item, target = {"ts": ts, "source": src, "text": text}, prompts
        else:
            item, target = {"ts": ts, "source": src, "text": text[:MAX_AGENT_TEXT]}, agent
        if session:
            pool = pooled.setdefault(session, {"prompts": [], "agent": []})
            target = pool["prompts" if kind == "human" else "agent"]
        target.append(item)
    return prompts, agent, pooled


def merge_pools(old, fresh):
    out = {doc: {k: list(v.get(k, [])) for k in ("prompts", "agent")} for doc, v in (old or {}).items()}
    for doc, v in fresh.items():
        pool = out.setdefault(doc, {"prompts": [], "agent": []})
        for k in ("prompts", "agent"):
            pool[k] = sorted(pool[k] + v[k], key=lambda x: x["ts"])[-POOL_MAX:]
    return out


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
        "sentence_ids": {"type": "array", "items": {"type": "string"}},
        "keep_ids": {"type": "array", "items": {"type": "integer"}},
        "keep_agent_ids": {"type": "array", "items": {"type": "integer"}},
        "decisions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["sentence_ids", "keep_ids", "keep_agent_ids", "decisions"],
}


def split_sentences(text):
    """Split into (sentence, separator-after) pairs; joining them all gives back the stripped text."""
    parts = re.split(r"((?<=[.!?])[ \t]+|[ \t]*\n\s*)", text.strip())
    pairs = [(parts[i], parts[i + 1] if i + 1 < len(parts) else "") for i in range(0, len(parts), 2)]
    return [(s, sep) for s, sep in pairs if s.strip()]


def numbered(prompt):
    return "\n".join(f"[{prompt['id']}.{i + 1}] {s}" for i, (s, _) in enumerate(split_sentences(prompt["text"])))


def excerpt(text, keep):
    """The kept sentences (0-based indices) verbatim, with […] where sentences were left out."""
    sents = split_sentences(text)
    keep = sorted(i for i in keep if 0 <= i < len(sents))
    out, prev = "", None
    for i in keep:
        if prev is None:
            out += "[…] " if i > 0 else ""
        elif i == prev + 1:
            out += sents[prev][1]
        else:
            out += "\n[…]\n" if "\n" in sents[i - 1][1] else " […] "
        out += sents[i][0]
        prev = i
    if prev is not None and prev < len(sents) - 1:
        out += " […]"
    return out


def ask_sonnet(diff, rest, message, prompts, agent):
    timeline = sorted(
        [{"ts": p["ts"], "s": f"[HUMAN PROMPT id={p['id']} via {p['source']}]\n{numbered(p)}"} for p in prompts]
        + [{"ts": a["ts"], "s": f"[AGENT id={a['id']} via {a['source']}]\n{a['text']}"} for a in agent],
        key=lambda x: x["ts"],
    )
    task = f"""You annotate a git commit with the human prompts that led to it.

Below are the staged diff (what this commit contains), the changes that stay uncommitted,
the draft commit message, and a timeline of human prompts and agent replies from coding
sessions. Some entries may be older than the rest; they were carried over from earlier
commits because their work was not committed, or not started, yet. Entries "via page-chat in
session …" were made in the app for one session's own code, and this commit promotes that code
into the repository, so the staged diff may implement them in a different form; select their
sentences only where the staged diff carries what they asked for. Each human prompt is split
into numbered sentences: [3.2] is sentence 2 of prompt 3.

1. sentence_ids: ids (like "3.2") of every human prompt sentence that contributed to the
   staged diff: it asked for the changes, shaped them, corrected them, or gave requirements
   they implement. The selected sentences are quoted verbatim in the commit message, so pick
   only those that carry information about this commit. Leave out sentences that only ask
   questions, concern other work, or add no information, such as approving or confirming a
   plan the agent proposed ("Yes.", "go ahead", "sounds good"): the intent is already in the
   earlier prompt that led to the plan.
2. keep_ids: integer ids of HUMAN PROMPTs whose work is not done by this commit: they
   contributed to the uncommitted changes, or the discussion they started is still open
   because the agent offered a concrete change and asked whether to make it, and that change
   is in neither the staged diff nor the uncommitted changes. Don't keep remarks about some
   unspecified future ("we should look at that someday"). A prompt can count for both 1 and 2
   if its work is split across staged and uncommitted changes.
3. keep_agent_ids: integer ids of AGENT replies that describe such open or uncommitted work,
   for example the reply proposing the change. They are shown again next time, so that a
   later approval like "Yes." can be understood.
4. decisions: usually empty. Only if the reason for a change in the staged diff cannot be
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


REDACTED = "<redacted>"
URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s<>\"'`)\]]+", re.I)
URL_PARAM = re.compile(r"([?#&;][^=&#;\s]+=)[^&#;\s]*")
SECRET_ASSIGN = re.compile(
    r"(\b(?:[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?)|auth|authorization|cookie)"
    r"[\"']?\s*[:=]\s*[\"']?)(?!Bearer\b|Basic\b)[^\s\"'&,;]{6,}", re.I)
TOKEN_FORMATS = re.compile(
    r"\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}"
    r"|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})")
BEARER = re.compile(r"\b(Bearer|Basic)\s+[\w.~+/=-]{12,}", re.I)
LONG_WORD = re.compile(r"(?<![\w/.-])[A-Za-z0-9_-]{24,}(?![\w/.-])")


def looks_random(word):
    """Mixed case and digits, and not just hex (commit hashes, UUIDs): an API key or similar."""
    return (re.search(r"[a-z]", word) and re.search(r"[A-Z]", word) and re.search(r"\d", word)
            and not re.fullmatch(r"[0-9a-fA-F-]+", word))


def redact(text):
    """Blank out credentials and private identifiers before prompts are quoted in a commit message,
    which may end up public: URL parameter values (keys, doc and room ids), `name=secret` and
    `token: secret` assignments, known token formats, and long random-looking strings."""
    text = URL.sub(lambda m: URL_PARAM.sub(lambda p: p[1] + REDACTED, m[0]), text)
    text = BEARER.sub(lambda m: f"{m[1]} {REDACTED}", text)
    text = TOKEN_FORMATS.sub(REDACTED, text)
    text = SECRET_ASSIGN.sub(lambda m: m[1] + REDACTED, text)
    return LONG_WORD.sub(lambda m: REDACTED if looks_random(m[0]) else m[0], text)


def quote(text):
    return "\n".join(("> " + line).rstrip() for line in redact(text).strip().splitlines())


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
    pools = (pending or {}).get("sessions", {})
    if pending is not None:
        since, carried, carried_agent = pending["cursor"], pending["prompts"], pending.get("agent", [])
    else:
        try:
            since = int(git("log", "-1", "--format=%ct").strip())
        except subprocess.CalledProcessError:
            since = 0  # first commit
        carried, carried_agent = [], []
    fresh, fresh_agent, fresh_pooled = collect(root, since)
    pools = merge_pools(pools, fresh_pooled)
    # A commit promoting a session's code: that session's page-chat turns are candidates too.
    promoted = [doc for doc in dict.fromkeys(PROMOTES.findall(message)) if doc in pools]
    from_pool = lambda doc, items: [{**x, "pool": doc, "source": f"page-chat in session {doc}"} for x in items]
    pooled = [x for doc in promoted for x in from_pool(doc, pools[doc]["prompts"])]
    pooled_agent = [x for doc in promoted for x in from_pool(doc, pools[doc]["agent"])]
    prompts = [{**p, "id": i + 1} for i, p in enumerate(sorted(carried + fresh + pooled, key=lambda p: p["ts"]))]
    agent = [{**a, "id": i + 1} for i, a in enumerate(sorted(carried_agent + fresh_agent + pooled_agent, key=lambda a: a["ts"]))]

    data = {"sentence_ids": [], "keep_ids": [], "keep_agent_ids": [], "decisions": []}
    if prompts:
        if not shutil.which("claude"):
            raise RuntimeError("`claude` (Claude Code CLI) not found on PATH")
        print(f"commit-prompts: asking Sonnet about {len(prompts)} prompt(s)…", file=sys.stderr)
        draft = "\n".join(l for l in message.splitlines() if not l.startswith("#"))
        data = ask_sonnet(diff, uncommitted_changes(), draft, prompts, agent)

    by_id = {p["id"]: p for p in prompts}
    # Pooled turns stay in their pool anyway, so they are never carried as well.
    kept = [by_id[i] for i in sorted(set(data.get("keep_ids", []))) if i in by_id and "pool" not in by_id[i]]
    agent_by_id = {a["id"]: a for a in agent}
    kept_agent = [agent_by_id[i] for i in sorted(set(data.get("keep_agent_ids", []))) if i in agent_by_id and "pool" not in agent_by_id[i]]
    sel = {}  # prompt id -> 0-based sentence indices; a bare "3" means the whole prompt
    for sid in data.get("sentence_ids", []):
        m = re.fullmatch(r"\s*(\d+)(?:\.(\d+))?\s*", str(sid))
        if m and int(m[1]) in by_id:
            p = int(m[1])
            sel.setdefault(p, set()).update(
                [int(m[2]) - 1] if m[2] else range(len(split_sentences(by_id[p]["text"]))))
    chosen = [q for q in (excerpt(by_id[p]["text"], sel[p]) for p in sorted(sel)) if q.strip()]
    # A pooled prompt quoted here has landed in the base: it leaves its session's pool.
    quoted = {(by_id[p]["ts"], by_id[p]["text"]) for p in sel if "pool" in by_id[p]}
    for doc in promoted:
        pools[doc]["prompts"] = [x for x in pools[doc]["prompts"] if (x["ts"], x["text"]) not in quoted]
    decisions = [d.strip() for d in data.get("decisions", []) if d.strip()]

    sd.mkdir(parents=True, exist_ok=True)
    strip = lambda p: {k: p[k] for k in ("ts", "source", "text")}
    (sd / "next.json").write_text(json.dumps(
        {"cursor": now, "prompts": [strip(p) for p in kept], "agent": [strip(a) for a in kept_agent],
         "sessions": {doc: v for doc, v in pools.items() if v["prompts"] or v["agent"]}}, indent=1))
    if kept or kept_agent:
        print(f"commit-prompts: carrying {len(kept)} prompt(s) and {len(kept_agent)} agent reply(ies) to a later commit",
              file=sys.stderr)

    section = []
    if chosen:
        section.append(HEADER + "\n\n" + "\n\n".join(quote(q) for q in chosen))
    if decisions:
        section.append("Agent decisions:\n\n" + "\n".join(f"- {redact(d)}" for d in decisions))
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
