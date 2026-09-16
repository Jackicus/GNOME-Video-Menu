# Thin front door; all logic lives in scripts/dev.sh
DEV := ./scripts/dev.sh
NESTED := ./scripts/nested.sh

.PHONY: all link install reload logs pack scan prune uninstall status clean help \
        nested nested-stop nested-status preview

all: install

link install reload logs pack scan prune uninstall status:
	@$(DEV) $@

clean:
	rm -f src/schemas/gschemas.compiled
	rm -rf dist
	find src -name '__pycache__' -type d -prune -exec rm -rf {} +

# Nested shell -- a throwaway second GNOME Shell for visual testing.
nested:
	@$(NESTED) start

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
