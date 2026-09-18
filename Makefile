# Thin front door; all logic lives in scripts/: dev.sh for the extension
# itself, nested.sh for the throwaway shell the visual checks run in.
DEV := ./scripts/dev.sh
NESTED := ./scripts/nested.sh

.PHONY: all link install reload logs pack scan prune uninstall status clean help \
        nested nested-headless nested-stop nested-status preview

all: install

link install reload logs pack scan prune uninstall status:
	@$(DEV) $@

clean:
	rm -f src/schemas/gschemas.compiled
	rm -rf dist
	find src -name '__pycache__' -type d -prune -exec rm -rf {} +

# Nested shell -- a throwaway second GNOME Shell for visual testing. Opens a live
# mirror window on the desktop so you can watch; nested-headless skips that.
nested:
	@$(NESTED) start

nested-headless:
	@$(NESTED) start --headless

nested-stop:
	@$(NESTED) stop

nested-status:
	@$(NESTED) status

preview:
	@$(NESTED) start >/dev/null && $(NESTED) shot

help:
	@$(DEV) help
	@echo
	@$(NESTED) help
