# Tunnex desktop client — build + gates.
#
# ⛔ THE GO PIN IS DUPLICATED IN THREE PLACES AND THEY MUST AGREE: this variable,
# apps/helper/go.mod's `go` directive, and .github/workflows/ci.yml's `go-version-file`.
# In the monorepo a script enforced that agreement across a dozen sites; here there are
# three, and CI derives its version from apps/helper/go.mod so only this one can drift.
GO_IMAGE := golang:1.25.13-alpine

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: test-helper
test-helper: ## Vet + test the privilege-helper core
	docker run --rm -v "$(PWD)/apps/helper":/src -w /src -e GOFLAGS=-mod=readonly \
	  $(GO_IMAGE) sh -c "apk add --no-cache git && go vet ./... && go test ./..."

.PHONY: helper-crosscompile
helper-crosscompile: ## Compile-check the helper (incl. platform build-tagged files) for all targets
	@for t in darwin/amd64 darwin/arm64 windows/amd64; do \
	  goos=$${t%/*}; goarch=$${t#*/}; echo ">> $$goos/$$goarch (CGO off)"; \
	  docker run --rm -v "$(PWD)/apps/helper":/src -w /src -e GOFLAGS=-mod=readonly \
	    -e CGO_ENABLED=0 -e GOOS=$$goos -e GOARCH=$$goarch \
	    $(GO_IMAGE) sh -c "apk add --no-cache git && go build ./..." || exit 1; \
	done

.PHONY: gates
gates: ## Everything CI checks, locally
	pnpm install --frozen-lockfile
	pnpm --filter @tunnex/client typecheck
	pnpm --filter @tunnex/client test
	pnpm --filter @tunnex/client build
	pnpm --filter @tunnex/web build
	$(MAKE) test-helper
	$(MAKE) helper-crosscompile

.PHONY: pack-mac
pack-mac: ## Build the macOS .pkg (unsigned)
	pnpm --filter @tunnex/client pack:mac

.PHONY: pack-win
pack-win: ## Build the Windows .exe (unsigned) — MUST run natively on Windows
	pnpm --filter @tunnex/client pack:win
