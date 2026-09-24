#!/usr/bin/env bash
#
# Media Libraries development helper.
#
#   ./scripts/dev.sh link       symlink src/ into the extensions dir (dev mode)
#   ./scripts/dev.sh install    copy src/ into the extensions dir (real install)
#   ./scripts/dev.sh reload     recompile schemas and disable/enable the extension
#   ./scripts/dev.sh logs [since]  shell logs; follows unless given e.g. '5 min ago'
#   ./scripts/dev.sh pack       build a distributable .shell-extension.zip
#   ./scripts/dev.sh scan [args]   scan every enabled section; passes extra
#                                  arguments through, e.g. --only films --force
#   ./scripts/dev.sh prune      remove superseded builds, keeping the current one
#   ./scripts/dev.sh uninstall  remove the extension (and stale older builds)
#   ./scripts/dev.sh status     show what is currently installed and enabled
#   ./scripts/dev.sh stalls [LOG]  watch for desktop freezes: shell main-loop
#                                  stalls, processes stuck in the kernel and
#                                  automount triggers, with timestamps
#   ./scripts/dev.sh clean      remove compiled schemas, dist/ and unshipped files
#
set -euo pipefail

UUID="media-libraries@jackt"
# Append to this on each rename so `prune` sweeps up every superseded build.
LEGACY_UUIDS=("gnomeflix@jackt" "media-workspace-desktop@jackt")
CACHE_DIR="$HOME/.cache/media-libraries"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_DIR/src"
EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"
EXT_DIR="$EXT_ROOT/$UUID"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH."
}

compile_schemas() {
    require glib-compile-schemas
    info "Compiling GSettings schemas..."
    glib-compile-schemas "$SRC_DIR/schemas"
}

remove_installed() {
    # -e misses a symlink whose target is gone, so test -L as well.
    if [[ -e "$EXT_DIR" || -L "$EXT_DIR" ]]; then
        rm -rf "$EXT_DIR"
    fi
}

is_enabled() {
    gnome-extensions list --enabled 2>/dev/null | grep -qx "$UUID"
}

# Bytecode Python leaves behind. Nothing here is checked in, so it is the only
# part of the strip that is safe to run over the working tree itself.
strip_pycache() {
    find "$1" -name '__pycache__' -type d -prune -exec rm -rf {} +
    find "$1" -name '*.pyc' -type f -delete
}

# Drop what the extension directory ships from but a checkout doesn't need:
# bytecode caches and the per-directory CLAUDE.md notes. Only ever called on a
# COPY of src/ — the plain-cp install fallback and the pack staging copy — since
# those CLAUDE.md files are checked in and deleting them from src/ is a loss.
strip_unshipped() {
    strip_pycache "$1"
    find "$1" -name 'CLAUDE.md' -type f -delete
}

cmd_link() {
    compile_schemas
    remove_installed
    mkdir -p "$EXT_ROOT"
    ln -s "$SRC_DIR" "$EXT_DIR"
    ok "Linked $EXT_DIR → $SRC_DIR"
    warn "Dev mode: edits in src/ are live. Run './scripts/dev.sh reload' to apply them."
    enable_extension
}

cmd_install() {
    compile_schemas
    remove_installed
    mkdir -p "$EXT_DIR"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete \
            --exclude '__pycache__/' --exclude '*.pyc' --exclude 'CLAUDE.md' \
            "$SRC_DIR"/ "$EXT_DIR"/
    else
        cp -r "$SRC_DIR"/. "$EXT_DIR"/
        strip_unshipped "$EXT_DIR"
    fi
    ok "Installed to $EXT_DIR"
    enable_extension
}

enable_extension() {
    require gnome-extensions
    if is_enabled; then
        cmd_reload
    else
        info "Enabling $UUID..."
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            ok "Enabled."
        else
            warn "The running GNOME Shell does not know about $UUID yet."
            warn "Log out and back in (Wayland) or Alt+F2 'r' (X11), then: make reload"
        fi
    fi
}

# Poll until the shell reports the wanted state, up to ~6s.
wait_for_state() {
    local want="$1" tries=0
    while (( tries < 60 )); do
        [[ "$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p')" == "$want" ]] && return 0
        sleep 0.1
        tries=$((tries + 1))
    done
    return 1
}

cmd_reload() {
    require gnome-extensions
    compile_schemas
    info "Reloading $UUID..."
    gnome-extensions disable "$UUID" 2>/dev/null || true
    # The shell applies disable asynchronously. Calling enable before it lands is
    # a silent no-op -- the shell still believes the extension is enabled, so it
    # never re-runs enable(), and you are left with State: INACTIVE, Enabled: Yes
    # and nothing at all in the log.
    wait_for_state INACTIVE || warn "Extension did not report INACTIVE; enabling anyway."
    gnome-extensions enable "$UUID"
    if wait_for_state ACTIVE; then
        ok "Reloaded. extension.js cache-busts the module import, so no shell restart needed."
    else
        warn "Extension is enabled but not ACTIVE. Check './scripts/dev.sh logs' for a JS error."
        return 1
    fi
}

# With no argument, follow the journal. With one (any systemd time spec, e.g.
# "5 min ago" or "today"), print what is already there and exit -- which is what
# non-interactive callers such as the .claude slash commands need.
cmd_logs() {
    require journalctl
    if [[ -n "${1:-}" ]]; then
        info "Media Libraries log output since '$1':"
        journalctl -o cat /usr/bin/gnome-shell --since "$1" 2>/dev/null \
            | grep -iE 'media.libraries' || info "(nothing logged in that window)"
    else
        info "Following GNOME Shell logs (Ctrl+C to stop)..."
        journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -iE 'media.libraries'
    fi
}

cmd_pack() {
    require gnome-extensions
    compile_schemas
    local out="$REPO_DIR/dist"
    mkdir -p "$out"
    info "Packing extension..."
    # pack bundles everything under --extra-source dirs and has no exclude flag,
    # so pack a staged copy with the byte-compiled cruft and CLAUDE.md notes removed
    local stage
    stage=$(mktemp -d)
    cp -r "$SRC_DIR"/. "$stage"/
    strip_unshipped "$stage"
    ( cd "$stage" && gnome-extensions pack --force \
        --extra-source=lib \
        --extra-source=backend \
        --extra-source=icons \
        -o "$out" . )
    rm -rf "$stage"
    ok "Packed to $out/$UUID.shell-extension.zip"
}

# Scan every enabled section. The scanner reads the preferences itself
# (--from-settings), so which setting becomes which flag is decided in exactly
# one place rather than here and in the preferences' Rescan buttons as well.
# Extra arguments are passed straight through, e.g. '--only films' or '--force'.
cmd_scan() {
    require python3
    compile_schemas
    # The API keys are read straight out of the preferences by the scanner,
    # along with everything else --from-settings covers, so nothing has to be
    # handed to it here and no key ever reaches a command line.
    python3 "$SRC_DIR/backend/scan_library.py" --from-settings "$@"
}

# Remove superseded builds of this extension, leaving the current one alone.
cmd_prune() {
    local found=0
    for legacy in "${LEGACY_UUIDS[@]}"; do
        if [[ -e "$EXT_ROOT/$legacy" || -L "$EXT_ROOT/$legacy" ]]; then
            gnome-extensions disable "$legacy" 2>/dev/null || true
            rm -rf "$EXT_ROOT/$legacy"
            ok "Removed stale build $legacy"
            found=1
        fi
    done
    [[ $found -eq 0 ]] && info "No stale builds to remove."
    return 0
}

cmd_uninstall() {
    remove_installed
    ok "Removed $EXT_DIR"
    cmd_prune
}

cmd_clean() {
    rm -f "$SRC_DIR/schemas/gschemas.compiled"
    rm -rf "$REPO_DIR/dist"
    strip_pycache "$SRC_DIR"
    ok "Cleaned compiled schemas, dist/ and bytecode caches under src/."
}

# A freeze is over by the time anyone looks; this leaves a log of what stalled.
cmd_stalls() {
    require python3
    info "Watching for freezes (Ctrl+C to stop); reproduce one, then read the log."
    python3 "$REPO_DIR/scripts/stallwatch.py" "$@"
}

cmd_status() {
    if [[ -L "$EXT_DIR" ]]; then
        echo "install:  symlink → $(readlink -f "$EXT_DIR")"
    elif [[ -d "$EXT_DIR" ]]; then
        echo "install:  copy at $EXT_DIR"
    else
        echo "install:  not installed"
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        local state
        # pipefail would abort the script when the extension is not registered yet
        state="$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p' || true)"
        echo "state:    ${state:-unknown to the running shell (log out and back in)}"
    fi
    echo "cache:    $CACHE_DIR$([[ -d "$CACHE_DIR" ]] || echo ' (absent)')"
    if [[ -f "$CACHE_DIR/library.json" ]]; then
        # Read through the scanner's own loader rather than restating how the
        # file is shaped (and how the version 1 format is read) a second time.
        echo "library:  $(python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
from scan_library import load_existing
s = load_existing(sys.argv[2])
print(", ".join(f"{len(v)} {k}" for k, v in s.items()) or "empty")' \
            "$SRC_DIR/backend" "$CACHE_DIR/library.json" 2>/dev/null || echo 'unreadable')"
    else
        echo "library:  not scanned yet"
    fi
}

usage() {
    # Print the comment header (everything after the shebang, up to the first blank
    # non-comment line), stripping the leading '#'.
    sed -n '2,/^[^#]/p' "${BASH_SOURCE[0]}" | sed -n 's/^#\{1\} \{0,1\}//p'
}

case "${1:-}" in
    link)       cmd_link ;;
    install)    cmd_install ;;
    reload)     cmd_reload ;;
    logs)       cmd_logs "${2:-}" ;;
    pack)       cmd_pack ;;
    scan)       shift; cmd_scan "$@" ;;
    prune)      cmd_prune ;;
    uninstall)  cmd_uninstall ;;
    status)     cmd_status ;;
    stalls)     shift; cmd_stalls "$@" ;;
    clean)      cmd_clean ;;
    ""|-h|--help|help) usage ;;
    *)          die "Unknown command '$1'. Run './scripts/dev.sh help'." ;;
esac
