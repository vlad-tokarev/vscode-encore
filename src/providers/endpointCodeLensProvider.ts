import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { EncoreAppState } from "../utils/encoreAppState";

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
 * For multi-app workspaces, the app ID is resolved from the discovered
 * Encore app that contains the document being inspected. Results are
 * cached by app root path so repeated lens renders do not hit disk.
 */
export class EndpointCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  /** Cached app IDs keyed by Encore app root path. */
  private readonly appIdCache = new Map<string, string | undefined>();

  private readonly appStateSubscription: vscode.Disposable;

  constructor(private readonly encoreAppState: EncoreAppState) {
    this.appStateSubscription = this.encoreAppState.onDidChange(() => {
      this.appIdCache.clear();
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const fileName = document.fileName;
    if (fileName.endsWith("_test.go") || fileName.endsWith("encore.gen.go")) {
      return [];
    }

    const appRootPath = await this.encoreAppState.getDiscoveredAppRootForFile(fileName);
    if (!appRootPath) {
      return [];
    }

    const appId = this.resolveAppId(appRootPath);
    if (!appId) {
      return [];
    }

    return buildLenses(document, appId);
  }

  dispose(): void {
    this.appStateSubscription.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  private resolveAppId(appRootPath: string): string | undefined {
    if (this.appIdCache.has(appRootPath)) {
      return this.appIdCache.get(appRootPath);
    }

    const appId = readAppIdFromDisk(path.join(appRootPath, "encore.app"));
    this.appIdCache.set(appRootPath, appId);
    return appId;
  }
}

function buildLenses(
  document: vscode.TextDocument,
  appId: string,
): vscode.CodeLens[] {
  const dashboardBase = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/${appId}`;
  // The Encore dashboard URL uses the service name without dashes.
  const serviceName = path.basename(path.dirname(document.fileName)).replace(/-/g, "");
  const lenses: vscode.CodeLens[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const trimmed = line.text.trimStart();

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

    if (!API_DIRECTIVE_RE.test(trimmed)) {
      continue;
    }

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

function readAppIdFromDisk(encoreAppPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(encoreAppPath, "utf-8");
    const idMatch = raw.match(/"id"\s*:\s*"([^"]+)"/);
    return idMatch?.[1];
  } catch {
    return undefined;
  }
}
