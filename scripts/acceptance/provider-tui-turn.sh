#!/usr/bin/env bash
# Acceptance harness: one real TUI turn on a signed-in provider, measured in tmux 120x40.
# Starts `unclecode work --provider <p> --model <m>` in a scratch workspace, sends one prompt that
# needs a tool, saves a frame every 0.5 s, and reports when the tool trace and the answer
# appeared. Needs real credentials (e.g. `unclecode auth login xai`) — it spends tokens.
#
# usage: scripts/acceptance/provider-tui-turn.sh <out-dir> <provider> <model> [timeout-sec]
# exit:  0 = tool trace and answer seen, 1 = TUI never became ready, 2 = turn incomplete
set -u
OUT=$1; PROVIDER=$2; MODEL=$3; TIMEOUT=${4:-120}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
READY_RE='◇ Ready'
MARKER=acceptance-marker-7f3a
mkdir -p "$OUT"; rm -f "$OUT"/f-*.txt "$OUT"/summary.txt
WORK=$(mktemp -d)
printf 'alpha\n' > "$WORK/$MARKER.txt"
printf 'beta\n' > "$WORK/second-file.txt"
S=ucturn$$
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
cleanup() { tmux kill-session -t "$S" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

T0=$(now_ms)
tmux new-session -d -s "$S" -x 120 -y 40 -c "$WORK" \
  "node '$REPO/bin/unclecode.cjs' work --provider '$PROVIDER' --model '$MODEL'; echo EXIT=\$?; sleep 30"
ready=""
for _ in $(seq 1 600); do
  tmux has-session -t "$S" 2>/dev/null || break
  if tmux capture-pane -p -t "$S" | grep -q "$READY_RE"; then ready=$(( $(now_ms) - T0 )); break; fi
  sleep 0.1
done
if [ -z "$ready" ]; then
  tmux capture-pane -p -t "$S" > "$OUT/not-ready.txt"
  echo "ready_ms=none" | tee "$OUT/summary.txt"
  exit 1
fi

PROMPT="List the files in the current directory with a tool, then reply with the exact name of the file that contains '$MARKER'."
tmux send-keys -t "$S" -l "$PROMPT"; tmux send-keys -t "$S" Enter
T1=$(now_ms)
tool=""; answer=""; n=0
while tmux has-session -t "$S" 2>/dev/null; do
  el=$(( $(now_ms) - T1 ))
  frame="$OUT/f-$(printf %04d $n).txt"
  { echo "t_ms=$el"; tmux capture-pane -p -t "$S"; } > "$frame"
  # Tool trace: the TUI prints a call as `● <snake_case_tool> <args>` (lowercase, which
  # excludes home-screen lines like `● Ready for the next move`). Answer: the marker file
  # name on a line that is not the prompt echo.
  if [ -z "$tool" ] && grep -Eq '^[[:space:]]*● [a-z][a-z_]*( |$)' "$frame"; then tool=$el; fi
  if [ -z "$answer" ] && grep -v "List the files" "$frame" | grep -q "$MARKER.txt"; then answer=$el; fi
  if [ -n "$answer" ] && grep -q "$READY_RE" "$frame"; then break; fi
  [ "$el" -ge $(( TIMEOUT * 1000 )) ] && break
  n=$((n+1)); sleep 0.5
done
tmux capture-pane -p -S -200 -t "$S" > "$OUT/final.txt" 2>/dev/null
echo "provider=$PROVIDER model=$MODEL ready_ms=$ready tool_trace_ms=${tool:-none} answer_ms=${answer:-none} frames=$((n+1))" | tee "$OUT/summary.txt"
[ -n "$tool" ] && [ -n "$answer" ] || exit 2
