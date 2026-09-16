#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/gnomeflix@jackt"

echo "→ Compiling GSettings schema..."
glib-compile-schemas "$PROJECT_DIR/schemas"

echo "→ Installing Gnomeflix to $EXT_DIR..."
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r "$PROJECT_DIR"/metadata.json "$EXT_DIR"/
cp -r "$PROJECT_DIR"/extension.js "$EXT_DIR"/
cp -r "$PROJECT_DIR"/media_workspace.js "$EXT_DIR"/
cp -r "$PROJECT_DIR"/prefs.js "$EXT_DIR"/
cp -r "$PROJECT_DIR"/stylesheet.css "$EXT_DIR"/
cp -r "$PROJECT_DIR"/media_scanner.py "$EXT_DIR"/
cp -r "$PROJECT_DIR"/metadata.py "$EXT_DIR"/
cp -r "$PROJECT_DIR"/schemas "$EXT_DIR"/

echo "✓ Gnomeflix installed successfully!"
