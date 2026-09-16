#!/usr/bin/env bash
#
# Drive a throwaway nested GNOME Shell for testing Gnomeflix.
#
#   ./scripts/nested.sh start [WxH]   start a nested shell (default 1600x900) and open
#                                     a live mirror window of it on the real desktop
#   ./scripts/nested.sh start --headless [WxH]
#                                     no mirror window; screenshots are the only view
#   ./scripts/nested.sh mirror on|off open/close the live mirror window
#   ./scripts/nested.sh say TEXT      flash TEXT as an on-screen banner in the nested
#                                     shell, so whoever is watching knows what's next
#   ./scripts/nested.sh shot [FILE]   screenshot the nested desktop to a PNG
#   ./scripts/nested.sh click X Y     click at those desktop coordinates
#   ./scripts/nested.sh move X Y      move the pointer there (hover) without clicking
#   ./scripts/nested.sh key KEYSYM    press a key or chord (Escape, Super+Page_Down, ...)
#   ./scripts/nested.sh overview on|off   show/hide the Activities overview
#   ./scripts/nested.sh reload        disable/enable Gnomeflix inside the nested shell
#   ./scripts/nested.sh run CMD...    run CMD against the nested shell's session bus
#   ./scripts/nested.sh logs [N]      last N lines of the nested shell's own output
#   ./scripts/nested.sh status        is it running, and what is it running as
#   ./scripts/nested.sh stop          shut it down and clean up
#
# The nested shell is a complete second GNOME Shell with its own session bus. It
# reads the same ~/.local/share/gnome-shell/extensions, so it picks up new UUIDs at
# its own startup -- and if the extension throws, it dies instead of your session.
#
# It always runs headless: this mutter build has no windowed (nested) backend.
# The mirror is a screencast of its virtual monitor, played on the real desktop
# through PipeWire, which both sessions share. That is how you watch along.
#
set -euo pipefail

UUID="gnomeflix@jackt"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/gnomeflix-nested"
BUS_FILE="$RUN_DIR/bus"
PID_FILE="$RUN_DIR/pid"
LOG_FILE="$RUN_DIR/log"
GEOM_FILE="$RUN_DIR/geometry"
MIRROR_PID_FILE="$RUN_DIR/mirror-pid"
MIRROR_LOG="$RUN_DIR/mirror-log"
# The real session's display and bus, captured before nested_env overrides them:
# the mirror window has to open on the desktop the user is looking at.
HOST_WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
HOST_BUS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}"
DRIVER="$REPO_DIR/scripts/nested_driver.py"
WL_DISPLAY="gnomeflix-dev"

info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

is_running() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

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
        warn "A nested shell is already running (pid $(cat "$PID_FILE")). Reusing it."
        [[ $mirror -eq 1 ]] && ! mirror_running && cmd_mirror on
        return 0
    fi

    command -v gnome-shell >/dev/null || die "'gnome-shell' not found."
    command -v dbus-run-session >/dev/null || die "'dbus-run-session' not found."

    # Make sure the extension is installed before the shell scans for it, since a
    # nested shell only discovers UUIDs at startup -- same as the real one.
    if [[ ! -e "$HOME/.local/share/gnome-shell/extensions/$UUID" ]]; then
        warn "$UUID is not installed; running 'make link' first."
        "$REPO_DIR/scripts/dev.sh" link >/dev/null 2>&1 || true
    fi

    mkdir -p "$RUN_DIR"
    rm -f "$BUS_FILE" "$PID_FILE"
    : > "$LOG_FILE"
    echo "$geometry" > "$GEOM_FILE"

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
    while (( waited < 200 )); do
        if [[ -s "$BUS_FILE" ]] && nested_env gdbus call --session \
                --dest org.gnome.Shell --object-path /org/gnome/Shell \
                --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; then
            ok "Nested shell up (pid $pid)."
            [[ $mirror -eq 1 ]] && cmd_mirror on
            cmd_status
            return 0
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            warn "Nested shell exited during startup. Last output:"
            tail -20 "$LOG_FILE" >&2
            rm -f "$PID_FILE"
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done

    warn "Nested shell did not answer on D-Bus within 20s. Last output:"
    tail -20 "$LOG_FILE" >&2
    return 1
}

cmd_stop() {
    mirror_running && cmd_mirror off
    if ! is_running; then
        info "No nested shell running."
        rm -rf "$RUN_DIR"
        return 0
    fi
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
    rm -rf "$RUN_DIR"
    ok "Nested shell stopped."
}

# The nested shell boots into the overview, which covers the desktop surface
# Gnomeflix draws on. Every capture and every click has to drop back to the
# desktop first, or it acts on the overview instead.
ensure_desktop() {
    nested_env python3 "$DRIVER" overview off >/dev/null 2>&1 || true
    sleep 0.5
}

cmd_shot() {
    require_running
    local out="${1:-$REPO_DIR/dist/nested-$(date +%H%M%S).png}"
    [[ "$out" = /* ]] || out="$PWD/$out"
    mkdir -p "$(dirname "$out")"
    ensure_desktop
    nested_env python3 "$DRIVER" shot "$out" >/dev/null || die "Screenshot failed."
    ok "Screenshot: $out"
    echo "$out"
}

cmd_click() {
    require_running
    [[ $# -eq 2 ]] || die "Usage: ./scripts/nested.sh click X Y"
    ensure_desktop
    local geom w h
    geom="$(cat "$GEOM_FILE" 2>/dev/null || echo '1920x1080')"
    w="${geom%x*}"; h="${geom#*x}"
    nested_env python3 "$DRIVER" click "$1" "$2" "$w" "$h"
}

cmd_move() {
    require_running
    [[ $# -eq 2 ]] || die "Usage: ./scripts/nested.sh move X Y"
    ensure_desktop
    local geom w h
    geom="$(cat "$GEOM_FILE" 2>/dev/null || echo '1920x1080')"
    w="${geom%x*}"; h="${geom#*x}"
    nested_env python3 "$DRIVER" move "$1" "$2" "$w" "$h"
}

cmd_key() {
    require_running
    [[ $# -eq 1 ]] || die "Usage: ./scripts/nested.sh key Escape"
    nested_env python3 "$DRIVER" key "$1"
}

cmd_overview() {
    require_running
    [[ "${1:-}" =~ ^(on|off)$ ]] || die "Usage: ./scripts/nested.sh overview on|off"
    nested_env python3 "$DRIVER" overview "$1"
}

nested_state() {
    nested_env gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p'
}

cmd_reload() {
    require_running
    info "Reloading $UUID inside the nested shell..."
    nested_env gnome-extensions disable "$UUID" 2>/dev/null || true
    # Same race as the real session: enabling before the disable lands is a silent
    # no-op that leaves the extension INACTIVE with nothing in the log.
    local tries=0
    while [[ "$(nested_state)" != "INACTIVE" ]] && (( tries < 60 )); do
        sleep 0.1
        tries=$((tries + 1))
    done
    nested_env gnome-extensions enable "$UUID" || die "Could not enable $UUID in the nested shell."
    tries=0
    while [[ "$(nested_state)" != "ACTIVE" ]] && (( tries < 60 )); do
        sleep 0.1
        tries=$((tries + 1))
    done
    [[ "$(nested_state)" == "ACTIVE" ]] \
        || die "Enabled but not ACTIVE -- check './scripts/nested.sh logs' for a JS error."
    ok "Reloaded."
}

# Show a banner in the nested shell via its own OSD (the volume/brightness popup),
# so someone watching the mirror sees what is about to happen. Use it before every
# click; it is harmless when nobody is watching.
cmd_say() {
    require_running
    [[ $# -gt 0 ]] || die "Usage: ./scripts/nested.sh say 'Opening Black Clover'"
    nested_env python3 "$DRIVER" say "$@"
}

mirror_running() {
    [[ -f "$MIRROR_PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$MIRROR_PID_FILE" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# The live mirror: the driver screencasts the nested monitor to a PipeWire node
# and keeps the session alive while a GStreamer viewer, running against the REAL
# desktop, plays it in an ordinary window. Cursor is embedded, so clicks can be
# followed. Closing the window ends the cast; 'mirror off' does the same.
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
            geom="$(cat "$GEOM_FILE" 2>/dev/null || echo '1600x900')"
            w="${geom%x*}"; h="${geom#*x}"
            : > "$MIRROR_LOG"
            nested_env setsid python3 "$DRIVER" stream "$w" "$h" \
                env WAYLAND_DISPLAY="$HOST_WAYLAND_DISPLAY" DBUS_SESSION_BUS_ADDRESS="$HOST_BUS" \
                    gst-launch-1.0 -q pipewiresrc path='{node}' ! videoconvert ! autovideosink \
                >>"$MIRROR_LOG" 2>&1 &
            echo $! > "$MIRROR_PID_FILE"
            local waited=0
            while (( waited < 50 )) && ! grep -q "pipewire node" "$MIRROR_LOG" 2>/dev/null; do
                if ! mirror_running; then
                    warn "Mirror failed to start:"; tail -5 "$MIRROR_LOG" >&2; rm -f "$MIRROR_PID_FILE"; return 1
                fi
                sleep 0.1; waited=$((waited + 1))
            done
            ok "Mirror window open on the desktop ($geom). Close it or run 'mirror off' to stop."
            ;;
        off)
            if ! mirror_running; then
                info "No mirror open."
                rm -f "$MIRROR_PID_FILE"
                return 0
            fi
            local pid
            pid="$(cat "$MIRROR_PID_FILE")"
            kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
            rm -f "$MIRROR_PID_FILE"
            ok "Mirror closed."
            ;;
        *) die "Usage: ./scripts/nested.sh mirror on|off" ;;
    esac
}

cmd_run() {
    require_running
    [[ $# -gt 0 ]] || die "Nothing to run. Usage: ./scripts/nested.sh run gnome-extensions list"
    nested_env "$@"
}

cmd_logs() {
    [[ -f "$LOG_FILE" ]] || die "No nested shell log at $LOG_FILE."
    tail -n "${1:-40}" "$LOG_FILE"
}

cmd_status() {
    if is_running; then
        echo "nested:   running (pid $(cat "$PID_FILE")), $(cat "$GEOM_FILE" 2>/dev/null)"
        echo "mirror:   $(mirror_running && echo "open on the desktop (pid $(cat "$MIRROR_PID_FILE"))" || echo "closed -- './scripts/nested.sh mirror on' to watch")"
        echo "bus:      $(cat "$BUS_FILE" 2>/dev/null || echo 'not yet published')"
        echo "log:      $LOG_FILE"
        local state
        state="$(nested_env gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p' || true)"
        echo "gnomeflix: ${state:-not registered in the nested shell}"
    else
        echo "nested:   not running"
    fi
}

usage() {
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

case "${1:-}" in
    start)  shift; cmd_start "$@" ;;
    stop)   cmd_stop ;;
    shot)     cmd_shot "${2:-}" ;;
    click)    shift; cmd_click "$@" ;;
    move)     shift; cmd_move "$@" ;;
    key)      cmd_key "${2:-}" ;;
    overview) cmd_overview "${2:-}" ;;
    say)      shift; cmd_say "$@" ;;
    mirror)   cmd_mirror "${2:-}" ;;
    reload) cmd_reload ;;
    run)    shift; cmd_run "$@" ;;
    logs)   cmd_logs "${2:-}" ;;
    status) cmd_status ;;
    ""|-h|--help|help) usage ;;
    *)      die "Unknown command '$1'. Run './scripts/nested.sh help'." ;;
esac
