import * as vscode from "vscode";
import { EncoreAppState } from "../utils/encoreAppState";

/**
 * Matches Go test, benchmark, and fuzz function declarations.
 */
const TEST_FUNC_RE = /^func\s+(Test\w+|Benchmark\w+|Fuzz\w+)\s*\(/;

/**
 * Matches t.Run("subtest name", ...) calls.
 * Captures the subtest name from double-quoted or backtick-quoted strings.
 */
const SUBTEST_RE = /\b(\w+)\.Run\(\s*(?:"([^"]+)"|`([^`]+)`)/;

/**
 * Provides "run Encore test | debug Encore test" Code Lenses above each Go test
 * function and subtest in *_test.go files.
 */
export class EncoreTestCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly appStateSubscription: vscode.Disposable;

  constructor(private readonly encoreAppState: EncoreAppState) {
    this.appStateSubscription = this.encoreAppState.onDidChange(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  dispose(): void {
    this.appStateSubscription.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    return this.provideCodeLensesForDocument(document);
  }

  private async provideCodeLensesForDocument(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    if (!document.fileName.endsWith("_test.go")) {
      return [];
    }

    const hasEncoreAppRoot = await this.encoreAppState.hasDiscoveredAppRootForFile(document.fileName);
    if (!hasEncoreAppRoot) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    let currentFuncName: string | undefined;

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);

      // Top-level test function.
      const funcMatch = line.text.match(TEST_FUNC_RE);
      if (funcMatch) {
        currentFuncName = funcMatch[1];
        const range = new vscode.Range(i, 0, i, line.text.length);

        lenses.push(
          new vscode.CodeLens(range, {
            title: "run Encore test",
            command: "encore.runTest",
            arguments: [document.uri, currentFuncName],
            tooltip: `Run ${currentFuncName} via encore test`,
          }),
          new vscode.CodeLens(range, {
            title: "debug Encore test",
            command: "encore.debugTest",
            arguments: [document.uri, currentFuncName],
            tooltip: `Debug ${currentFuncName} via encore test -c + dlv`,
          }),
        );
        continue;
      }

      // Subtest via t.Run().
      if (currentFuncName) {
        const subMatch = line.text.match(SUBTEST_RE);
        if (subMatch) {
          const subtestName = subMatch[2] ?? subMatch[3];
          if (subtestName) {
            const runPattern = `${currentFuncName}/${subtestName}`;
            const range = new vscode.Range(i, 0, i, line.text.length);

            lenses.push(
              new vscode.CodeLens(range, {
                title: "run Encore test",
                command: "encore.runTest",
                arguments: [document.uri, runPattern],
                tooltip: `Run ${runPattern} via encore test`,
              }),
              new vscode.CodeLens(range, {
                title: "debug Encore test",
                command: "encore.debugTest",
                arguments: [document.uri, runPattern],
                tooltip: `Debug ${runPattern} via encore test -c + dlv`,
              }),
            );
          }
        }

        // End of current function body.
        if (line.text.length > 0 && line.text[0] === "}" && !line.text.startsWith("})")) {
          currentFuncName = undefined;
        }
      }
    }

    return lenses;
  }
}
