SHELL := /bin/bash
UUID := gnomeflix@jackt
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all compile install enable disable reload pack clean

all: compile install

compile:
	@echo "Compiling GSettings schemas..."
	glib-compile-schemas schemas/

install: compile
	@echo "Installing to $(INSTALL_DIR)..."
	@bash install.sh

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

reload: disable enable
	@echo "Gnomeflix reloaded via dynamic module loader."

pack: compile
	gnome-extensions pack --force --extra-source=media_workspace.js --extra-source=media_scanner.py --extra-source=metadata.py -o /tmp .
	@echo "Extension packed to /tmp/$(UUID).shell-extension.zip"

clean:
	rm -f schemas/gschemas.compiled
	rm -f /tmp/$(UUID).shell-extension.zip
