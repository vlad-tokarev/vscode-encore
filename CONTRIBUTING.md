# Contributing

Thank you for contributing to Encore for VS Code.

## Development Environment

Contributors need the following tools:

- Node.js 20 or newer
- npm
- VS Code
- Encore CLI on `PATH`
- A local Encore Go project for manual verification

## Local Development

Install dependencies and compile the extension:

```bash
npm install
npm run compile
```

Launch the extension in an Extension Development Host with `F5` from VS Code.

## Development Workflow

Use the following workflow for most changes:

1. Create a branch for the change.
2. Make the code or documentation change.
3. Run `npm run compile`.
4. Verify the changed behaviour in an Encore workspace.
5. Update `README.md` or `CHANGELOG.md` when user-visible behaviour changes.

## Code Guidelines

The codebase uses TypeScript with strict compiler settings.

Please follow the existing project conventions:

- Keep comments explicit enough to stand alone.
- Prefer clear names over short generic names.
- Keep explorer labels and command titles concise.
- Avoid changes that break multi-app workspaces.

## AI-Assisted Contributions

AI-assisted contributions are welcome.

Each AI-assisted contribution must follow the [Code Guidelines](#code-guidelines).

The contributor submitting an AI-assisted contribution must personally complete the relevant checks in [Manual Verification](#manual-verification).

The contributor submitting an AI-assisted contribution remains responsible for the correctness, safety, and maintainability of the submitted change.

## Manual Verification

Changes that touch CLI-backed features should be checked against a real Encore project.

Manual verification should cover the relevant areas:

- Go to Definition from generated Encore wrappers
- Encore explorer rendering
- Encore Cloud login state
- Run and debug actions
- Test actions
- Database and secret helpers when applicable

## Pull Requests

Pull requests should include:

- A short description of the user-facing change
- Notes about verification steps
- Screenshots or short recordings for explorer or UI changes when helpful

## Release Notes

User-visible changes should be summarised in [CHANGELOG.md](./CHANGELOG.md).

Publication steps live in [RELEASING.md](./RELEASING.md).
