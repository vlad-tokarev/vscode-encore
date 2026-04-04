import * as vscode from "vscode";
import * as path from "path";
import { ENCORE_APP_EXCLUDE_GLOB } from "../utils/workspaceScan";

/**
 * Matches //encore:api directive lines.
 */
const API_DIRECTIVE_RE = /^\/\/encore:api\b/;

/**
 * Matches //encore:service directive lines.
 */
const SERVICE_DIRECTIVE_RE = /^\/\/encore:service\b/;

/**
 * Matches a Go function declaration and captures the function name.
 * Handles both package-level functions and method receivers.
 */
const FUNC_RE = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/;

/** Default port of the Encore development dashboard. */
const DEFAULT_DASHBOARD_PORT = 9400;

/**
 * Provides an "open in console" Code Lens above each //encore:api
 * and //encore:service directive in Go source files. The lens opens
 * the corresponding page in the Encore development dashboard.
 *
 * The dashboard URL is constructed from the app ID read from
 * encore.app and the default dashboard port (9400), so the lenses
 * are always visible regardless of how the app was started.
 */
export class EndpointCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  /** Cached app ID read from encore.app. */
  private appId: string | undefined;
  private appIdLoaded = false;

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    // Skip test files and generated files.
    const fileName = document.fileName;
    if (fileName.endsWith("_test.go") || fileName.endsWith("encore.gen.go")) {
      return [];
    }

    if (!this.appIdLoaded) {
      return this.loadAppId().then(() => {
        console.log(`[Encore] EndpointCodeLens: appId=${this.appId}, file=${fileName}`);
        return this.buildLenses(document);
      });
    }

    return this.buildLenses(document);
  }

  dispose(): void {
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  private buildLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.appId) {
      return [];
    }

    const dashboardBase = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/${this.appId}`;
    // The Encore dashboard URL uses the service name without dashes.
    const serviceName = path.basename(path.dirname(document.fileName)).replace(/-/g, "");
    const lenses: vscode.CodeLens[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const trimmed = line.text.trimStart();

      // //encore:service → open the service page in the console.
      if (SERVICE_DIRECTIVE_RE.test(trimmed)) {
        const serviceUrl = `${dashboardBase}/envs/local/api/${serviceName}`;
        const range = new vscode.Range(i, 0, i, line.text.length);
        lenses.push(
          new vscode.CodeLens(range, {
            title: "$(globe) Open",
            command: "encore.openEndpointInConsole",
            arguments: [serviceUrl],
            tooltip: `Open service ${serviceName} in the Encore development console`,
          }),
        );
        continue;
      }

      // //encore:api → open the specific endpoint page in the console.
      if (!API_DIRECTIVE_RE.test(trimmed)) {
        continue;
      }

      // Look for the function name on the next non-empty, non-comment line.
      let endpointName: string | undefined;
      for (let j = i + 1; j < document.lineCount && j <= i + 5; j++) {
        const nextLine = document.lineAt(j).text.trimStart();
        if (nextLine.length === 0 || nextLine.startsWith("//")) {
          continue;
        }
        const funcMatch = nextLine.match(FUNC_RE);
        if (funcMatch) {
          endpointName = funcMatch[1];
        }
        break;
      }

      if (!endpointName) {
        continue;
      }

      const consoleUrl = `${dashboardBase}/envs/local/api/${serviceName}/${endpointName}`;
      const range = new vscode.Range(i, 0, i, line.text.length);

      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(globe) Open",
          command: "encore.openEndpointInConsole",
          arguments: [consoleUrl],
          tooltip: `Open ${serviceName}.${endpointName} in the Encore development console`,
        }),
      );
    }

    return lenses;
  }

  /**
   * Read the app ID from the first encore.app file found in the workspace.
   * The file uses JSONC format (comments and trailing commas allowed),
   * so a simple regex extraction is used instead of JSON.parse.
   */
  private async loadAppId(): Promise<void> {
    this.appIdLoaded = true;
    try {
      const files = await vscode.workspace.findFiles("**/encore.app", ENCORE_APP_EXCLUDE_GLOB, 1);
      if (files.length === 0) {
        console.log("[Encore] EndpointCodeLens: encore.app not found in workspace");
        return;
      }
      const content = Buffer.from(
        await vscode.workspace.fs.readFile(files[0]),
      ).toString("utf-8");
      // Extract "id" value with a regex to handle JSONC (comments, trailing commas).
      const idMatch = content.match(/"id"\s*:\s*"([^"]+)"/);
      if (idMatch) {
        this.appId = idMatch[1];
        console.log(`[Encore] EndpointCodeLens: loaded appId="${this.appId}" from ${files[0].fsPath}`);
      } else {
        console.log(`[Encore] EndpointCodeLens: no "id" field found in ${files[0].fsPath}`);
      }
    } catch (err) {
      console.error("[Encore] EndpointCodeLens: failed to read encore.app", err);
    }
  }
}
