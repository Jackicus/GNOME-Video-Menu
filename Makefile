# Thin front door; all logic lives in scripts/dev.sh
DEV := ./scripts/dev.sh

.PHONY: all link install reload logs pack scan prune uninstall status clean help

all: install

link install reload logs pack scan prune uninstall status:
	@$(DEV) $@

clean:
	rm -f src/schemas/gschemas.compiled
	rm -rf dist
	find src -name '__pycache__' -type d -prune -exec rm -rf {} +

help:
	@$(DEV) help
