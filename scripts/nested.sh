#!/usr/bin/env bash
#
# Drive a throwaway nested GNOME Shell for testing Media Libraries.
#
#   ./scripts/nested.sh start [WxH]   start a nested shell (default 1600x900) with
#                                     Media Libraries ACTIVE, and open a live mirror window
#                                     of it on the real desktop
#   ./scripts/nested.sh start --headless [WxH]
#                                     no mirror window; screenshots are the only view
#   ./scripts/nested.sh do "STEP" "STEP"...
#                                     run several steps in one go (one connection):
#                                     say TEXT | click X Y | move X Y | key KEYSYM |
#                                     wait SECS | shot [FILE [X Y W H]] | overview on|off
#   ./scripts/nested.sh say TEXT      flash TEXT as an on-screen banner in the nested
#                                     shell, so whoever is watching knows what's next
#   ./scripts/nested.sh shot [FILE [X Y W H]]
#                                     screenshot the nested desktop (or one region)
#   ./scripts/nested.sh click X Y     click at those desktop coordinates
#   ./scripts/nested.sh move X Y      move the pointer there (hover) without clicking
#   ./scripts/nested.sh key KEYSYM    press a key or chord (Escape, Super+Page_Down, ...)
#   ./scripts/nested.sh overview on|off   show/hide the Activities overview
#   ./scripts/nested.sh reload        disable/enable Media Libraries inside the nested shell
#   ./scripts/nested.sh mirror on|off open/close the live mirror window
#   ./scripts/nested.sh run CMD...    run CMD against the nested shell's session bus
#   ./scripts/nested.sh logs [N] [--all]
#                                     last N lines of the nested shell's output, with
#                                     D-Bus activation chatter filtered out
#   ./scripts/nested.sh status        is it running, and what is it running as
#   ./scripts/nested.sh stop          close the mirror, shut the shell down, clean up
#
# The nested shell is a complete second GNOME Shell with its own session bus. It
# reads the same ~/.local/share/gnome-shell/extensions, so it picks up new UUIDs at
# its own startup -- and if the extension throws, it dies instead of your session.
#
# It always runs headless: this mutter build has no windowed (nested) backend.
# The mirror is a screencast of its virtual monitor, played on the real desktop
# through PipeWire, which both sessions share. That is how you watch along.
#
# Nothing is left behind on the desktop: the mirror closes when the shell stops or
# dies, and a shell started from a Claude Code session stops itself after
# MEDIA_LIBRARIES_NESTED_IDLE seconds (default 600, 0 = never) without a command here,
# and when that session ends (the SessionEnd hook runs 'session-end').
#
set -euo pipefail

UUID="media-libraries@jackt"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$REPO_DIR/scripts/nested.sh"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/media-libraries-nested"
BUS_FILE="$RUN_DIR/bus"
PID_FILE="$RUN_DIR/pid"
LOG_FILE="$RUN_DIR/log"
GEOM_FILE="$RUN_DIR/geometry"
MIRROR_PID_FILE="$RUN_DIR/mirror-pid"
MIRROR_LOG="$RUN_DIR/mirror-log"
WATCH_PID_FILE="$RUN_DIR/watchdog-pid"
ACTIVITY_FILE="$RUN_DIR/activity"
OWNER_FILE="$RUN_DIR/owner-session"
IDLE_FILE="$RUN_DIR/idle-seconds"
GUARD_OWNED_FILE="$RUN_DIR/owns-crash-guard"
# GNOME Shell creates this for its first 60 s; if the shell crashes while it
# exists, the systemd unit disables every extension. The nested shell shares the
# runtime dir, so it creates the REAL session's copy -- and a stop inside those
# 60 s leaves it behind, arming that for the user's next real crash.
CRASH_GUARD="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"
IDLE_SECS="${MEDIA_LIBRARIES_NESTED_IDLE:-600}"
# The real session's display and bus, captured before nested_env overrides them:
# the mirror window has to open on the desktop the user is looking at.
HOST_WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
HOST_BUS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}"
DRIVER="$REPO_DIR/scripts/nested_driver.py"
WL_DISPLAY="media-libraries-dev"

info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

pid_alive() {
    [[ -f "$1" ]] || return 1
    local pid
    pid="$(cat "$1" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_running()     { pid_alive "$PID_FILE"; }
mirror_running() { pid_alive "$MIRROR_PID_FILE"; }

require_running() {
    is_running || die "No nested shell running. Start one with: ./scripts/nested.sh start"
}

nested_bus() {
    [[ -s "$BUS_FILE" ]] || die "Nested shell has no session bus address yet."
    cat "$BUS_FILE"
}

# Run a command against the nested shell's bus rather than the real session's.
# Without this every gnome-extensions/gdbus call would hit your live desktop.
nested_env() {
    env DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" \
        WAYLAND_DISPLAY="$WL_DISPLAY" \
        "$@"
}

geometry() { cat "$GEOM_FILE" 2>/dev/null || echo '1600x900'; }

driver() {
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" python3 "$DRIVER" "$@"
}

nested_state() {
    nested_env gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p'
}

# Poll until the extension reaches STATE, up to about 6 seconds.
wait_state() {
    local tries=0
    while [[ "$(nested_state)" != "$1" ]] && (( tries < 60 )); do
        sleep 0.1
        tries=$((tries + 1))
    done
    [[ "$(nested_state)" == "$1" ]]
}

touch_activity() {
    [[ -d "$RUN_DIR" ]] && touch "$ACTIVITY_FILE" 2>/dev/null || true
}

cmd_start() {
    # Mirrored by default: the whole point of driving the extension is that the
    # user can see what is being tried, without logging out to look.
    local mirror=1
    case "${1:-}" in
        --headless|--no-mirror) mirror=0; shift ;;
        --windowed|--mirror) mirror=1; shift ;;
    esac
    local geometry="${1:-1600x900}"
    [[ "$geometry" =~ ^[0-9]+x[0-9]+$ ]] || die "Geometry must look like 1600x900, got '$geometry'."

    if is_running; then
        info "Reusing the nested shell already running (pid $(cat "$PID_FILE"), $(geometry))."
        [[ $mirror -eq 1 ]] && ! mirror_running && cmd_mirror on
        [[ "$(nested_state)" == "ACTIVE" ]] || enable_in_nested
        return 0
    fi

    command -v gnome-shell >/dev/null || die "'gnome-shell' not found."
    command -v dbus-run-session >/dev/null || die "'dbus-run-session' not found."

    # A crashed or killed run can leave a mirror or watchdog behind with no pid
    # file pointing at it; clear those before starting over.
    kill_strays

    # Make sure the extension is installed before the shell scans for it, since a
    # nested shell only discovers UUIDs at startup -- same as the real one.
    if [[ ! -e "$HOME/.local/share/gnome-shell/extensions/$UUID" ]]; then
        warn "$UUID is not installed; running 'make link' first."
        "$REPO_DIR/scripts/dev.sh" link >/dev/null 2>&1 || true
    fi

    rm -rf "$RUN_DIR"
    mkdir -p "$RUN_DIR"
    : > "$LOG_FILE"
    echo "$geometry" > "$GEOM_FILE"
    # If the real shell's own guard is already there (it logged in under a minute
    # ago), it is not ours to remove.
    [[ -e "$CRASH_GUARD" ]] || touch "$GUARD_OWNED_FILE"
    # Only a shell a Claude Code session started is that session's to clean up.
    [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] && echo "$CLAUDE_CODE_SESSION_ID" > "$OWNER_FILE"

    local mode_args=(--wayland --wayland-display "$WL_DISPLAY" --headless --virtual-monitor "$geometry")

    info "Starting nested GNOME Shell (headless, $geometry)..."

    # dbus-run-session creates the bus; we echo its address out so later commands
    # can address this shell specifically.
    setsid dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
        exec gnome-shell "${@:2}"
    ' _ "$BUS_FILE" "${mode_args[@]}" >>"$LOG_FILE" 2>&1 &

    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Wait for the shell to own its name on the new bus before declaring success.
    local waited=0
    until [[ -s "$BUS_FILE" ]] && nested_env gdbus call --session \
            --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; do
        if ! kill -0 "$pid" 2>/dev/null; then
            warn "Nested shell exited during startup. Last output:"
            filtered_log 20 >&2
            rm -f "$PID_FILE"
            return 1
        fi
        if (( waited >= 200 )); then
            warn "Nested shell did not answer on D-Bus within 20s. Last output:"
            filtered_log 20 >&2
            cmd_stop >/dev/null
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    ok "Nested shell up (pid $pid)."

    # The shell only enables what dconf lists, and a UUID the real session has never
    # enabled is not listed: it would sit at INITIALIZED doing nothing.
    if nested_env gsettings get org.gnome.shell enabled-extensions 2>/dev/null | grep -qF "'$UUID'"; then
        wait_state ACTIVE \
            || die "Media Libraries is $(nested_state) after startup -- check './scripts/nested.sh logs' for a JS error."
        ok "Media Libraries ACTIVE."
    else
        enable_in_nested
    fi

    touch_activity
    start_watchdog "$pid"
    [[ $mirror -eq 1 ]] && cmd_mirror on
    return 0
}

enable_in_nested() {
    nested_env gnome-extensions enable "$UUID" 2>/dev/null || die "Could not enable $UUID in the nested shell."
    wait_state ACTIVE \
        || die "Enabled but $(nested_state) -- check './scripts/nested.sh logs' for a JS error."
    ok "Media Libraries ACTIVE."
}

# Stops the nested shell after IDLE_SECS without a command, and cleans up (the
# mirror above all) if the shell dies on its own. Only for shells a Claude Code
# session started: a person watching the mirror is not sending commands, so for
# them silence is not idleness.
start_watchdog() {
    [[ -s "$OWNER_FILE" ]] || return 0
    [[ "$IDLE_SECS" =~ ^[0-9]+$ ]] || IDLE_SECS=600
    echo "$IDLE_SECS" > "$IDLE_FILE"
    setsid bash -c '
        self=$1 activity=$2 idle=$3 shell_pid=$4
        while kill -0 "$shell_pid" 2>/dev/null; do
            sleep 5
            [[ -f "$activity" ]] || exit 0
            if (( idle > 0 )); then
                age=$(( $(date +%s) - $(stat -c %Y "$activity" 2>/dev/null || date +%s) ))
                (( age >= idle )) && exec "$self" stop --idle
            fi
        done
        exec "$self" stop
    ' _ "$SELF" "$ACTIVITY_FILE" "$IDLE_SECS" "$1" >/dev/null 2>&1 < /dev/null &
    echo $! > "$WATCH_PID_FILE"
}

# Anything of ours that outlived its pid file: mirror streams and watchdogs.
kill_strays() {
    local pid
    for pid in $(pgrep -f -- "$DRIVER stream" 2>/dev/null) \
               $(pgrep -f -- "_ $SELF $ACTIVITY_FILE" 2>/dev/null); do
        [[ "$pid" == "$$" ]] && continue
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
}

cmd_stop() {
    [[ "${1:-}" == "--idle" ]] && info "Idle for $(cat "$IDLE_FILE" 2>/dev/null)s; stopping the nested shell."
    # Take the watchdog down first so it does not race this stop -- unless this
    # stop IS the watchdog, which exec'd into it.
    if pid_alive "$WATCH_PID_FILE"; then
        local wpid
        wpid="$(cat "$WATCH_PID_FILE")"
        [[ "$wpid" != "$$" ]] && { kill -TERM "-$wpid" 2>/dev/null || kill -TERM "$wpid" 2>/dev/null || true; }
    fi
    mirror_running && cmd_mirror off
    if is_running; then
        local pid
        pid="$(cat "$PID_FILE")"
        info "Stopping nested shell (pid $pid)..."
        # setsid gave it its own process group; kill the group so the bus goes too.
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null && (( waited < 50 )); do
            sleep 0.1
            waited=$((waited + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "Did not exit on TERM; sending KILL."
            kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        fi
        ok "Nested shell stopped."
    else
        info "No nested shell running."
    fi
    kill_strays
    [[ -e "$GUARD_OWNED_FILE" ]] && rm -f "$CRASH_GUARD"
    rm -rf "$RUN_DIR"
}

# SessionEnd hook: stop the nested shell only if the ending session started it.
# Reads the hook's JSON from stdin.
cmd_session_end() {
    [[ -s "$OWNER_FILE" ]] || return 0
    local ending
    ending="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)"
    [[ -n "$ending" && "$ending" == "$(cat "$OWNER_FILE")" ]] || return 0
    cmd_stop >/dev/null 2>&1
}

cmd_do() {
    require_running
    [[ $# -gt 0 ]] || die "Usage: ./scripts/nested.sh do \"say Opening a show\" \"click 125 280\" \"wait 1\" shot"
    driver batch "$@"
}

cmd_step() {
    require_running
    driver step "$@"
}

cmd_reload() {
    require_running
    info "Reloading $UUID inside the nested shell..."
    nested_env gnome-extensions disable "$UUID" 2>/dev/null || true
    # Same race as the real session: enabling before the disable lands is a silent
    # no-op that leaves the extension INACTIVE with nothing in the log.
    wait_state INACTIVE || true
    nested_env gnome-extensions enable "$UUID" || die "Could not enable $UUID in the nested shell."
    wait_state ACTIVE \
        || die "Enabled but not ACTIVE -- check './scripts/nested.sh logs' for a JS error."
    ok "Reloaded."
}

# The live mirror: the driver screencasts the nested monitor to a PipeWire node
# and keeps the session alive while a GStreamer viewer, running against the REAL
# desktop, plays it in an ordinary window. Cursor is embedded, so clicks can be
# followed. Closing the window ends the cast; 'mirror off', 'stop', or the nested
# shell going away all close the window.
cmd_mirror() {
    case "${1:-}" in
        on)
            require_running
            if mirror_running; then
                info "Mirror already open (pid $(cat "$MIRROR_PID_FILE"))."
                return 0
            fi
            command -v gst-launch-1.0 >/dev/null || die "'gst-launch-1.0' not found; install gstreamer and gst-plugin-pipewire."
            local geom w h
            geom="$(geometry)"
            w="${geom%x*}"; h="${geom#*x}"
            : > "$MIRROR_LOG"
            # Not through nested_env: a function call in the background forks a
            # subshell, and $! would be that short-lived subshell rather than the
            # stream, so 'mirror off' and 'stop' could never find the window.
            env DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" WAYLAND_DISPLAY="$WL_DISPLAY" \
                setsid python3 "$DRIVER" stream "$w" "$h" \
                env WAYLAND_DISPLAY="$HOST_WAYLAND_DISPLAY" DBUS_SESSION_BUS_ADDRESS="$HOST_BUS" \
                    gst-launch-1.0 -q pipewiresrc path='{node}' ! videoconvert ! autovideosink \
                >>"$MIRROR_LOG" 2>&1 < /dev/null &
            echo $! > "$MIRROR_PID_FILE"
            local waited=0
            while (( waited < 50 )) && ! grep -q "pipewire node" "$MIRROR_LOG" 2>/dev/null; do
                if ! mirror_running; then
                    warn "Mirror failed to start:"; tail -5 "$MIRROR_LOG" >&2; rm -f "$MIRROR_PID_FILE"; return 1
                fi
                sleep 0.1; waited=$((waited + 1))
            done
            ok "Mirror window open on the desktop ($geom)."
            ;;
        off)
            if ! mirror_running; then
                rm -f "$MIRROR_PID_FILE"
                return 0
            fi
            local pid waited=0
            pid="$(cat "$MIRROR_PID_FILE")"
            kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
            while kill -0 "$pid" 2>/dev/null && (( waited < 30 )); do
                sleep 0.1; waited=$((waited + 1))
            done
            kill -0 "$pid" 2>/dev/null && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
            rm -f "$MIRROR_PID_FILE"
            ok "Mirror closed."
            ;;
        *) die "Usage: ./scripts/nested.sh mirror on|off" ;;
    esac
}

cmd_run() {
    require_running
    [[ $# -gt 0 ]] || die "Nothing to run. Usage: ./scripts/nested.sh run gnome-extensions list"
    # The driver's own variables go too, so `run python3 scripts/nested_driver.py …`
    # behaves as `do` does — without NESTED_RUN_DIR it cannot see the
    # "overview wanted" flag, and its first screenshot dismisses the overview.
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" "$@"
}

# The shell's log is mostly the bus daemon announcing service activations and the
# portal complaining about services a throwaway session does not have. None of it
# is about Media Libraries, and it buries the lines that are.
filtered_log() {
    grep -Ev "^\s*$|Activating (via systemd: )?service name=|Successfully activated service|Activated service 'org.freedesktop.systemd1' failed|RealtimeKit|AT-SPI|atk-bridge|discover_other_daemon|gnome-shell-calendar-server|libecal|Error loading calendars|No entry for geolocation" \
        "$LOG_FILE" | tail -n "$1"
}

cmd_logs() {
    [[ -f "$LOG_FILE" ]] || die "No nested shell log at $LOG_FILE."
    local n=40 all=0 arg
    for arg in "$@"; do
        case "$arg" in
            --all) all=1 ;;
            *[!0-9]*|"") die "Usage: ./scripts/nested.sh logs [N] [--all]" ;;
            *) n="$arg" ;;
        esac
    done
    if (( all )); then tail -n "$n" "$LOG_FILE"; else filtered_log "$n"; fi
}

cmd_status() {
    if is_running; then
        local state idle="" secs
        state="$(nested_state || true)"
        secs="$(cat "$IDLE_FILE" 2>/dev/null || echo 0)"
        pid_alive "$WATCH_PID_FILE" && (( secs > 0 )) && idle=", stops after ${secs}s idle"
        echo "nested:    running (pid $(cat "$PID_FILE")), $(geometry)$idle"
        echo "mirror:    $(mirror_running && echo "open on the desktop" || echo "closed -- 'mirror on' to watch")"
        echo "extension: ${state:-not registered in the nested shell}"
        echo "log:       $LOG_FILE"
    else
        echo "nested:    not running"
    fi
}

usage() {
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    start|stop|session-end|""|-h|--help|help) ;;
    *) touch_activity ;;
esac

case "$cmd" in
    start)       cmd_start "$@" ;;
    stop)        cmd_stop "$@" ;;
    session-end) cmd_session_end ;;
    do)          cmd_do "$@" ;;
    shot|click|move|key|overview|say)
                 cmd_step "$cmd" "$@" ;;
    mirror)      cmd_mirror "${1:-}" ;;
    reload)      cmd_reload ;;
    run)         cmd_run "$@" ;;
    logs)        cmd_logs "$@" ;;
    status)      cmd_status ;;
    ""|-h|--help|help) usage ;;
    *)           die "Unknown command '$cmd'. Run './scripts/nested.sh help'." ;;
esac
