# nervly-js (@nervly/sdk) — standalone task runner.
#
# Mirrors this repo's own CI job (.github/workflows/ci.yml). One sibling
# checkout is a real input: check-codegen.mjs and check-release.mjs (both run by
# `npm run check`) read ../nervly-docs/static/openapi/gateway.json. `make deps`
# reports it.
#
# `npm test` is the heavy pair (coverage + mutation) and is what CI runs;
# `make test-unit` and `make test-mutation` run them individually.

.PHONY: help deps install build codegen check-codegen check-types check changelog deprecations \
	release exports readme test test-unit test-coverage test-mutation test-live example audit sbom verify ci local-ci dev hooks clean

help:
	@echo "nervly-js (SDK) commands:"
	@echo "  make deps           - Check the sibling checkout this repo needs"
	@echo "  make install        - npm install (also wires Husky)"
	@echo "  make build          - build ESM + CJS bundles"
	@echo "  make check          - all release-discipline gates + typecheck"
	@echo "  make test           - coverage + mutation (what CI runs)"
	@echo "  make test-unit      - unit tests with the 80%% coverage floor"
	@echo "  make test-mutation  - seeded mutation test"
	@echo "  make example        - run the default example app (node-app)"
	@echo "  make exports        - dual ESM/CJS packaging gate"
	@echo "  make readme         - README gate (snippets type-check + docs agreement)"
	@echo "  make audit          - npm audit (runtime deps, high+)"
	@echo "  make sbom           - generate the release SBOM"
	@echo "  make test-live      - live contract suite (needs NERVLY_BASE_URL/NERVLY_API_KEY)"
	@echo "  make verify         - check + test"
	@echo "  make ci             - local mirror of this repo's CI job"
	@echo "  make local-ci       - alias for make ci"
	@echo "  make dev            - run the SDK dev entrypoint"
	@echo "  make hooks          - reinstall Husky hooks"
	@echo "  make clean          - remove dist/"

deps:
	@if [ -f ../nervly-docs/static/openapi/gateway.json ]; then \
		echo "  [ok]   ../nervly-docs/static/openapi/gateway.json"; \
	else \
		echo "  [MISS] ../nervly-docs/static/openapi/gateway.json"; \
		echo ""; \
		echo "Clone nervly-docs as a sibling for the codegen gates:"; \
		echo "  git clone https://github.com/igmrrf/nervly-docs ../nervly-docs"; \
		exit 1; \
	fi

install:
	npm install

build:
	npm run build

codegen:
	npm run codegen

check-codegen:
	npm run check:codegen

check-types:
	npm run check:types

changelog:
	npm run check:changelog

deprecations:
	npm run check:deprecations

release:
	npm run check:release

exports:
	npm run check:exports

readme:
	npm run check:readme

check:
	npm run check

test:
	npm test

test-unit:
	npm run test:coverage

test-coverage: test-unit

test-mutation:
	npm run test:mutation

# The live contract suite (root CI's sdk-live-contract job runs it against a
# booted stack). Locally: point NERVLY_BASE_URL at a running gateway.
test-live:
	npm run test:live

# The repo example convention (harness contract §2): node-app is the default;
# `make example` delegates to `npm run example`; extra args pass through, e.g.
# `make example ARGS="--json"` or `make example ARGS="edge-worker --json"`.
ARGS ?=
example:
	npm run example -- $(ARGS)

audit:
	npm run audit

sbom:
	npm run sbom

verify:
	npm run verify

ci: check test audit sbom exports readme
	@echo "==> nervly-js CI steps complete."

# Uniform workspace entry point: `make local-ci` is this repo's local CI.
local-ci: ci

dev:
	npm run dev

hooks:
	npm run prepare

clean:
	rm -rf dist
