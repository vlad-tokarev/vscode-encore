NAME    := encore
VERSION := $(shell node -p "require('./package.json').version")
VSIX    := $(NAME)-$(VERSION).vsix

.PHONY: install compile package publish-marketplace publish-openvsx bump-patch bump-minor bump-major clean

## Install npm dependencies
install:
	npm install

## Compile TypeScript
compile: install
	npm run compile

## Package the extension into a .vsix file
package: compile
	npx @vscode/vsce package -o $(VSIX)
	@echo "Packaged $(VSIX)"

## Publish to VS Code Marketplace (requires VSCE_PAT environment variable)
publish-marketplace: package
	npx @vscode/vsce publish -i $(VSIX)

## Publish to Open VSX (requires OVSX_PAT environment variable)
publish-openvsx: package
	npx ovsx publish $(VSIX) -p $(OVSX_PAT)

## Bump patch version (0.1.0 → 0.1.1), commit and tag
bump-patch:
	npm version patch

## Bump minor version (0.1.0 → 0.2.0), commit and tag
bump-minor:
	npm version minor

## Bump major version (0.1.0 → 1.0.0), commit and tag
bump-major:
	npm version major

## Remove build artefacts
clean:
	rm -rf out *.vsix
