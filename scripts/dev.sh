#!/usr/bin/env bash
#
# Gnomeflix development helper.
#
#   ./scripts/dev.sh link       symlink src/ into the extensions dir (dev mode)
#   ./scripts/dev.sh install    copy src/ into the extensions dir (real install)
#   ./scripts/dev.sh reload     recompile schemas and disable/enable the extension
#   ./scripts/dev.sh logs       follow GNOME Shell logs, filtered to Gnomeflix
#   ./scripts/dev.sh pack       build a distributable .shell-extension.zip
#   ./scripts/dev.sh scan       run the library scanner against the configured path
#   ./scripts/dev.sh prune      remove superseded builds, keeping the current one
#   ./scripts/dev.sh uninstall  remove the extension (and stale older builds)
#   ./scripts/dev.sh status     show what is currently installed and enabled
#
set -euo pipefail

UUID="gnomeflix@jackt"
LEGACY_UUIDS=("media-workspace-desktop@jackt")
LEGACY_CACHE="$HOME/.cache/gnome-media-center"
CACHE_DIR="$HOME/.cache/gnomeflix"

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

# The cache dir was named after the extension's former name. Move it across once
# so previously downloaded posters and metadata are not orphaned.
migrate_cache() {
    if [[ -d "$LEGACY_CACHE" && ! -d "$CACHE_DIR" ]]; then
        info "Migrating cache $LEGACY_CACHE → $CACHE_DIR"
        mv "$LEGACY_CACHE" "$CACHE_DIR"
    fi
    mkdir -p "$CACHE_DIR"
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

cmd_link() {
    compile_schemas
    migrate_cache
    remove_installed
    mkdir -p "$EXT_ROOT"
    ln -s "$SRC_DIR" "$EXT_DIR"
    ok "Linked $EXT_DIR → $SRC_DIR"
    warn "Dev mode: edits in src/ are live. Run './scripts/dev.sh reload' to apply them."
    enable_extension
}

cmd_install() {
    compile_schemas
    migrate_cache
    remove_installed
    mkdir -p "$EXT_DIR"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete \
            --exclude '__pycache__/' --exclude '*.pyc' \
            "$SRC_DIR"/ "$EXT_DIR"/
    else
        cp -r "$SRC_DIR"/. "$EXT_DIR"/
        find "$EXT_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
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

cmd_reload() {
    require gnome-extensions
    compile_schemas
    info "Reloading $UUID..."
    gnome-extensions disable "$UUID" 2>/dev/null || true
    gnome-extensions enable "$UUID"
    ok "Reloaded. extension.js cache-busts the module import, so no shell restart needed."
}

cmd_logs() {
    require journalctl
    info "Following GNOME Shell logs (Ctrl+C to stop)..."
    journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i gnomeflix
}

cmd_pack() {
    require gnome-extensions
    compile_schemas
    local out="$REPO_DIR/dist"
    mkdir -p "$out"
    info "Packing extension..."
    # pack bundles everything under --extra-source dirs, byte-compiled cruft included
    find "$SRC_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} +
    ( cd "$SRC_DIR" && gnome-extensions pack --force \
        --extra-source=lib \
        --extra-source=backend \
        -o "$out" . )
    ok "Packed to $out/$UUID.shell-extension.zip"
}

cmd_scan() {
    require python3
    migrate_cache
    local tv_path
    tv_path="$(gsettings --schemadir "$SRC_DIR/schemas" \
        get org.gnome.shell.extensions.gnomeflix tv-shows-path 2>/dev/null | tr -d "'")"
    info "Scanning library${tv_path:+ at $tv_path}..."
    if [[ -n "$tv_path" ]]; then
        python3 "$SRC_DIR/backend/scan_library.py" --tv-path "$tv_path"
    else
        python3 "$SRC_DIR/backend/scan_library.py"
    fi
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
        echo "library:  $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))), "shows")' "$CACHE_DIR/library.json" 2>/dev/null || echo 'unreadable')"
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
    logs)       cmd_logs ;;
    pack)       cmd_pack ;;
    scan)       cmd_scan ;;
    prune)      cmd_prune ;;
    uninstall)  cmd_uninstall ;;
    status)     cmd_status ;;
    ""|-h|--help|help) usage ;;
    *)          die "Unknown command '$1'. Run './scripts/dev.sh help'." ;;
esac
