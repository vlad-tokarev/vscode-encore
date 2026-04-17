# Releasing

This document describes the release process for Encore for VS Code.

## Prerequisites

Release tooling expects the following access:

- A VS Code Marketplace publisher token
- An Open VSX access token
- Permission to publish under the configured publisher namespace

The examples below use `VSCE_PAT` for the VS Code Marketplace token and `OPENVSX_PAT` for the Open VSX token.

## Release Checklist

1. Update the version in `package.json`.
2. Update [CHANGELOG.md](./CHANGELOG.md).
3. Review [README.md](./README.md) for accurate marketplace copy.
4. Run `npm install` when dependencies changed.
5. Run `npm run compile`.
6. Verify the extension in an Encore workspace.

## Package Validation

Create a local package before publishing:

```bash
npx @vscode/vsce package
```

Inspect the generated `.vsix` and confirm that the package contains the compiled extension, bundled resources, `README.md`, `CHANGELOG.md`, and `LICENSE`.

## Publish to VS Code Marketplace

Publish the extension to the VS Code Marketplace:

```bash
VSCE_PAT=your-token npx @vscode/vsce publish
```

Publish a specific version when needed:

```bash
VSCE_PAT=your-token npx @vscode/vsce publish 0.1.0
```

## Publish to Open VSX

Publish the extension to Open VSX:

```bash
OPENVSX_PAT=your-token npx ovsx publish
```

Publish a specific version when needed:

```bash
OPENVSX_PAT=your-token npx ovsx publish 0.1.0
```

## Post-release Checks

Confirm the following items after publication:

- The extension page renders `README.md` correctly.
- The version matches the package metadata.
- Installation works from both marketplaces.
- The explorer activates correctly in a workspace with `encore.app`.
