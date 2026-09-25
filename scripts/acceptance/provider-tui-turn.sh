#!/usr/bin/env bash
# Acceptance harness: one real TUI turn on a signed-in provider, measured in tmux 120x40.
# Starts `unclecode work --provider <p> --model <m>` in a scratch workspace, sends one prompt that
# needs a tool, saves a frame every 0.5 s, and reports when the tool trace and the answer
# appeared. Needs real credentials (e.g. `unclecode auth login xai`) — it spends tokens.
#
# usage: scripts/acceptance/provider-tui-turn.sh <out-dir> <provider> <model> [timeout-sec]
# optional env: UC_TURN_SETUP (shell run in the scratch dir), UC_TURN_PRE (a line submitted
#               before the prompt, e.g. `/model xai/grok-4.3`), UC_TURN_PROMPT, UC_TURN_EXPECT
#               (fixed string the answer must contain; defaults to the marker file name),
#               UC_TURN_SCROLL_KEY (tmux key, e.g. PPage, sent once the answer streams; reports
#               whether the view moved and how many later streaming frames kept its top rows;
#               after the turn, UC_TURN_RESUME_KEY (default End) is sent before the answer check),
#               UNCLECODE_TUI_SHELL=pi (run the pi-tui shell instead of the Ink shell)
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
if [ -n "${UC_TURN_SETUP:-}" ]; then (cd "$WORK" && eval "$UC_TURN_SETUP"); fi
S=ucturn$$
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
# The TUI may start the shared runtime owner daemon with this scratch dir as its cwd; a
# daemon left in a deleted cwd fails every later Rust spawn with `spawnSync … ENOENT`.
# Stop any owner whose cwd is the scratch dir before removing it.
stop_owners_in_work() {
  for pid in $(pgrep -f runtime-owner-service); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qx "n$(cd "$WORK" && pwd -P)"; then kill "$pid"; fi
  done
}
cleanup() { tmux kill-session -t "$S" 2>/dev/null; stop_owners_in_work; rm -rf "$WORK"; }
trap cleanup EXIT

# tmux sessions inherit the tmux server's environment, not ours: forward proxy settings.
ENV_ARGS=()
for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy UNCLECODE_CODE_MODE UNCLECODE_TUI_SHELL; do
  if [ -n "${!name+x}" ]; then ENV_ARGS+=(-e "$name=${!name}"); fi
done

T0=$(now_ms)
tmux new-session -d -s "$S" -x 120 -y 40 -c "$WORK" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
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

if [ -n "${UC_TURN_PRE:-}" ]; then
  tmux send-keys -t "$S" -l "$UC_TURN_PRE"; tmux send-keys -t "$S" Enter
  sleep 3
  tmux capture-pane -p -t "$S" > "$OUT/after-pre.txt"
fi
PROMPT=${UC_TURN_PROMPT:-"List the files in the current directory with a tool, then reply with the exact name of the file that contains '$MARKER'."}
EXPECT=${UC_TURN_EXPECT:-"$MARKER.txt"}
tmux send-keys -t "$S" -l "$PROMPT"; tmux send-keys -t "$S" Enter
T1=$(now_ms)
tool=""; answer=""; n=0; torn=0
scroll_ms=""; resume_ms=""; pre_top=""; anchor=""; anchor_set=""; scroll_moved=no; scroll_frames=0; scroll_held=0
while tmux has-session -t "$S" 2>/dev/null; do
  el=$(( $(now_ms) - T1 ))
  frame="$OUT/f-$(printf %04d $n).txt"
  { echo "t_ms=$el"; tmux capture-pane -p -t "$S"; } > "$frame"
  # Tool trace: the TUI prints a call as `● <snake_case_tool> <args>` (lowercase, which
  # excludes home-screen lines like `● Ready for the next move`). Answer: the marker file
  # name on a line that is not the prompt echo.
  if [ -z "$tool" ] && grep -Eq '^[[:space:]]*● [a-z][a-z_]*( |$)' "$frame"; then tool=$el; fi
  if [ -z "$answer" ] && grep -vF "${PROMPT:0:40}" "$frame" | grep -qF "$EXPECT"; then answer=$el; fi
  # A torn frame shows the status row twice: something scrolled the terminal under the
  # renderer, and every row-based reading of that frame is suspect.
  [ "$(grep -cE '^ ?[◇◆] ' "$frame")" -gt 1 ] && torn=$((torn+1))
  # Scroll probe: the first overflowing frame showing the streaming cursor gets the key; every later
  # frame of the same turn should keep the top rows of the first post-key frame (the view
  # stays where the user scrolled while the answer grows below it).
  if [ -n "${UC_TURN_SCROLL_KEY:-}" ]; then
    top=$(sed -n '2,21p' "$frame")
    # Only once the answer overflows the viewport (the prompt echo has scrolled off):
    # before that there is nothing to scroll and the key proves nothing.
    if [ -z "$scroll_ms" ] && grep -q '▌' "$frame" && ! grep -qF "${PROMPT:0:40}" "$frame"; then
      pre_top=$top; tmux send-keys -t "$S" "$UC_TURN_SCROLL_KEY"; scroll_ms=$el
    elif [ -n "$scroll_ms" ] && ! grep -q "$READY_RE" "$frame"; then
      if [ -z "$anchor_set" ]; then
        anchor=$top; anchor_set=1
        [ "$anchor" != "$pre_top" ] && scroll_moved=yes
      else
        scroll_frames=$((scroll_frames+1)); [ "$top" = "$anchor" ] && scroll_held=$((scroll_held+1))
      fi
    fi
  fi
  # A scrolled-away view does not show the end of the answer: once the turn is done, send
  # the resume key and keep looking for the answer.
  if [ -n "$scroll_ms" ] && [ -z "$resume_ms" ] && grep -q "$READY_RE" "$frame"; then
    tmux send-keys -t "$S" "${UC_TURN_RESUME_KEY:-End}"; resume_ms=$el
  fi
  if [ -n "$answer" ] && grep -q "$READY_RE" "$frame"; then break; fi
  [ "$el" -ge $(( TIMEOUT * 1000 )) ] && break
  n=$((n+1)); sleep 0.5
done
tmux capture-pane -p -S -200 -t "$S" > "$OUT/final.txt" 2>/dev/null
calls=$(grep -cE '^[[:space:]]*● [a-z][a-z_]*( |$)' "$OUT/final.txt")
status=$(grep -oE '▤ [0-9]+ ctx · ~[0-9]+t|TTFT [0-9.]+s|\$[0-9.]+' "$OUT/final.txt" | tr '\n' ' ')
scroll=""
if [ -n "${UC_TURN_SCROLL_KEY:-}" ]; then
  scroll=" scroll_key=$UC_TURN_SCROLL_KEY scroll_key_ms=${scroll_ms:-none} scroll_moved=$scroll_moved scroll_held=$scroll_held/$scroll_frames resume_key_ms=${resume_ms:-none}"
fi
echo "provider=$PROVIDER model=$MODEL ready_ms=$ready tool_trace_ms=${tool:-none} answer_ms=${answer:-none} tool_lines=$calls status=[$status] frames=$((n+1)) torn_frames=$torn$scroll" | tee "$OUT/summary.txt"
[ -n "$tool" ] && [ -n "$answer" ] || exit 2
