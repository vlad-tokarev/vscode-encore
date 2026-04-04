import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";

import { GO_LANGUAGE_SELECTOR } from "./constants";
import { registerEncoreDirectiveDecorations } from "./decorations/encoreDirectives";
import { registerSecretDecorations } from "./decorations/secretDecorations";
import { registerEncoreDirectiveDiagnostics } from "./diagnostics/encoreDirectives";
import { EncoreDefinitionProvider } from "./providers/definitionProvider";
import { EncoreDirectiveCompletionProvider } from "./providers/directiveCompletionProvider";
import { EncoreDirectiveHoverProvider } from "./providers/directiveHoverProvider";
import { EncoreReferenceProvider } from "./providers/referenceProvider";
import { EncoreSecretCompletionProvider } from "./providers/secretCompletionProvider";
import { EndpointCodeLensProvider } from "./providers/endpointCodeLensProvider";
import { EncoreTestCodeLensProvider } from "./providers/testCodeLensProvider";
import { BucketStore } from "./encore/bucketStore";
import { CacheStore } from "./encore/cacheStore";
import { CronStore } from "./encore/cronStore";
import { DatabaseStore } from "./encore/databaseStore";
import { PubSubStore } from "./encore/pubsubStore";
import { SecretStore } from "./encore/secretStore";
import { ServiceStore } from "./encore/serviceStore";
import { registerTestController } from "./testing/testController";
import {
  createEncoreTestItemId,
  parseEncoreTestItemId,
} from "./testing/testItemId";
import { runEncoreTests, debugEncoreTest } from "./testing/testRunner";
import { GoFileWatcher } from "./utils/goFileWatcher";
import { EncoreTreeDataProvider, EncoreTreeItem } from "./panels/encoreTreeView";
import { AppRunner } from "./runner/appRunner";
import { AppStatusBar } from "./runner/statusBar";
import { ENCORE_APP_EXCLUDE_GLOB, GO_FILE_EXCLUDE_GLOB, isVisibleWorkspaceFile } from "./utils/workspaceScan";
import { buildEncoreEnv, isEncoreCliAvailable, promptMissingCli } from "./utils/encoreEnv";
import { EncoreAppState } from "./utils/encoreAppState";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const goFileWatcher = new GoFileWatcher();
  const encoreAppWatcher = vscode.workspace.createFileSystemWatcher("**/encore.app");
  const goModWatcher = vscode.workspace.createFileSystemWatcher("**/go.mod");
  const encoreAppState = new EncoreAppState();
  const secretStore = new SecretStore(context.globalStorageUri);
  const serviceStore = new ServiceStore();
  const cacheStore = new CacheStore();
  const databaseStore = new DatabaseStore(context.globalStorageUri);
  const pubsubStore = new PubSubStore();
  const bucketStore = new BucketStore();
  const cronStore = new CronStore();

  // Wire the shared watcher to all stores.
  goFileWatcher.onDidChangeFiles((events) => {
    serviceStore.handleFileChanges(events);
    cacheStore.handleFileChanges(events);
    databaseStore.handleFileChanges(events);
    pubsubStore.handleFileChanges(events);
    bucketStore.handleFileChanges(events);
    cronStore.handleFileChanges(events);
  });

  context.subscriptions.push(
    { dispose: () => goFileWatcher.dispose() },
    encoreAppWatcher,
    goModWatcher,
    { dispose: () => secretStore.dispose() },
    { dispose: () => serviceStore.dispose() },
    { dispose: () => cacheStore.dispose() },
    { dispose: () => databaseStore.dispose() },
    { dispose: () => pubsubStore.dispose() },
    { dispose: () => bucketStore.dispose() },
    { dispose: () => cronStore.dispose() },
    encoreAppState,
  );

  const initialEncoreAppFiles = await findEncoreAppFiles();
  encoreAppState.setDiscoveredAppRootPaths(
    collectEncoreAppRootPaths(initialEncoreAppFiles),
  );

  registerNavigationProviders(context, secretStore);
  registerEncoreDirectiveDecorations(context);
  registerSecretDecorations(context, secretStore);
  registerEncoreDirectiveDiagnostics(context);
  const treeDataProvider = registerEncoreExplorerPanel(
    context,
    secretStore,
    serviceStore,
    cacheStore,
    databaseStore,
    pubsubStore,
    bucketStore,
    cronStore,
  );
  registerTestSupport(context, encoreAppState);

  let isEncoreWorkspace = false;
  const refreshEncoreWorkspaceState = async (): Promise<void> => {
    const encoreAppFiles = await findEncoreAppFiles();
    const encoreAppRootPaths = collectEncoreAppRootPaths(encoreAppFiles);
    isEncoreWorkspace = encoreAppRootPaths.length > 0;
    encoreAppState.setDiscoveredAppRootPaths(encoreAppRootPaths);

    await vscode.commands.executeCommand(
      "setContext",
      "encore.isEncoreWorkspace",
      isEncoreWorkspace,
    );
    await treeDataProvider.refreshProjectState();

    if (!isEncoreWorkspace) {
      return;
    }

    databaseStore.fetchAllConnUris();
  };

  context.subscriptions.push(
    encoreAppWatcher.onDidCreate((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      void refreshEncoreWorkspaceState();
    }),
    encoreAppWatcher.onDidChange((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      void refreshEncoreWorkspaceState();
    }),
    encoreAppWatcher.onDidDelete((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      void refreshEncoreWorkspaceState();
    }),
    goModWatcher.onDidCreate((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      encoreAppState.invalidateGoModuleBoundaries();
    }),
    goModWatcher.onDidChange((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      encoreAppState.invalidateGoModuleBoundaries();
    }),
    goModWatcher.onDidDelete((uri) => {
      if (!isVisibleWorkspaceFile(uri)) {
        return;
      }
      encoreAppState.invalidateGoModuleBoundaries();
    }),
  );

  // Single initial scan shared across all stores.
  const goFiles = await vscode.workspace.findFiles(
    "**/*.go",
    GO_FILE_EXCLUDE_GLOB,
  );
  await Promise.all([
    serviceStore.scanFiles(goFiles),
    cacheStore.scanFiles(goFiles),
    databaseStore.scanFiles(goFiles),
    pubsubStore.scanFiles(goFiles),
    bucketStore.scanFiles(goFiles),
    cronStore.scanFiles(goFiles),
  ]);
  await refreshEncoreWorkspaceState();
}

function registerNavigationProviders(
  context: vscode.ExtensionContext,
  secretStore: SecretStore,
): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      GO_LANGUAGE_SELECTOR,
      new EncoreDefinitionProvider(),
    ),
    vscode.languages.registerReferenceProvider(
      GO_LANGUAGE_SELECTOR,
      new EncoreReferenceProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      GO_LANGUAGE_SELECTOR,
      new EncoreDirectiveCompletionProvider(),
      "/", ":", " ", "=", ",",
    ),
    vscode.languages.registerCompletionItemProvider(
      GO_LANGUAGE_SELECTOR,
      new EncoreSecretCompletionProvider(secretStore),
    ),
    vscode.languages.registerHoverProvider(
      GO_LANGUAGE_SELECTOR,
      new EncoreDirectiveHoverProvider(),
    ),
  );
}

function registerEncoreExplorerPanel(
  context: vscode.ExtensionContext,
  secretStore: SecretStore,
  serviceStore: ServiceStore,
  cacheStore: CacheStore,
  databaseStore: DatabaseStore,
  pubsubStore: PubSubStore,
  bucketStore: BucketStore,
  cronStore: CronStore,
): EncoreTreeDataProvider {
  const outputChannel = vscode.window.createOutputChannel("Encore App");
  const appRunner = new AppRunner(outputChannel);
  const appStatusBar = new AppStatusBar(appRunner);

  const treeDataProvider = new EncoreTreeDataProvider(
    secretStore, serviceStore, cacheStore, databaseStore, pubsubStore, bucketStore, cronStore,
    appRunner,
  );

  const treeView = vscode.window.createTreeView("encoreExplorer", {
    treeDataProvider,
    showCollapseAll: true,
  });

  /** Read run/debug settings from VS Code configuration. */
  function readRunOptions(debug: boolean) {
    const config = vscode.workspace.getConfiguration("encore");
    return {
      debug,
      port: config.get<number>("run.port", 4000),
      watch: debug ? false : config.get<boolean>("run.watch", true),
      logLevel: config.get<string>("run.logLevel", "") || undefined,
      stopOnEntry: config.get<boolean>("debug.stopOnEntry", false),
    };
  }

  context.subscriptions.push(
    treeView,
    appRunner,
    appStatusBar,
    treeDataProvider.startPolling(),
    vscode.commands.registerCommand("encore.refreshExplorer", () => {
      treeDataProvider.refresh();
    }),
    vscode.commands.registerCommand("encore.goToSource", async (item?: EncoreTreeItem) => {
      let filePath = item?.sourceFilePath;
      let line = item?.sourceFileLine ?? 0;

      if (!filePath) {
        // Called from Command Palette without arguments — show a QuickPick.
        const picks = buildGoToSourcePicks(serviceStore, databaseStore, cacheStore, pubsubStore, bucketStore, cronStore);
        if (picks.length === 0) {
          vscode.window.showInformationMessage("Encore: no navigable items found.");
          return;
        }
        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select an item to navigate to",
        });
        if (!selected) {
          return;
        }
        filePath = selected.filePath;
        line = selected.line;
      }

      vscode.commands.executeCommand("vscode.open",
        vscode.Uri.file(filePath),
        { selection: new vscode.Range(line, 0, line, 0) } as vscode.TextDocumentShowOptions,
      );
    }),
    vscode.commands.registerCommand("encore.startDaemon", async () => {
      if (!isEncoreCliAvailable()) {
        await promptMissingCli();
        return;
      }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      exec("encore daemon", { timeout: 15_000, cwd, env: buildEncoreEnv() }, (error) => {
        if (error) {
          vscode.window.showErrorMessage(`Failed to start Encore daemon: ${error.message}`);
          return;
        }
        treeDataProvider.refresh();
      });
    }),
    vscode.commands.registerCommand("encore.killDaemon", () => {
      treeDataProvider.killDaemon();
    }),
    vscode.commands.registerCommand("encore.copyDbConnUri", async (item?: { dataKey?: string }) => {
      let dbName = item?.dataKey;

      if (!dbName) {
        const databases = databaseStore.getDatabases();
        if (databases.length === 0) {
          vscode.window.showInformationMessage("Encore: no databases found.");
          return;
        }
        const picks = databases.map((db) => ({
          label: db.name,
          description: path.basename(path.dirname(db.filePath)),
        }));
        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select a database to copy connection URI",
        });
        if (!selected) {
          return;
        }
        dbName = selected.label;
      }

      const connUri = databaseStore.getConnUri(dbName);
      if (!connUri) {
        vscode.window.showWarningMessage(`Encore: connection URI not available for "${dbName}". Is the application running?`);
        return;
      }
      vscode.env.clipboard.writeText(connUri).then(() => {
        vscode.window.setStatusBarMessage(`$(check) Copied connection URI for "${dbName}"`, 3000);
      });
    }),
    vscode.commands.registerCommand("encore.runApp", () => {
      appRunner.run(readRunOptions(false));
    }),
    vscode.commands.registerCommand("encore.debugApp", () => {
      appRunner.run(readRunOptions(true));
    }),
    vscode.commands.registerCommand("encore.stopApp", () => {
      appRunner.stop();
    }),
    vscode.commands.registerCommand("encore.restartApp", () => {
      appRunner.restart();
    }),
    vscode.commands.registerCommand("encore.showAppOutput", () => {
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand("encore.openAppUrl", (url: string) => {
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    vscode.commands.registerCommand("encore.openEndpointInConsole", async (url?: string) => {
      if (!url) {
        // Called from Command Palette — show a QuickPick with all endpoints.
        const appId = await readAppId();
        if (!appId) {
          vscode.window.showWarningMessage("Encore: could not read app ID from encore.app.");
          return;
        }
        const picks = buildEndpointConsolePicks(serviceStore, appId);
        if (picks.length === 0) {
          vscode.window.showInformationMessage("Encore: no endpoints found.");
          return;
        }
        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select an endpoint to open in the development console",
        });
        if (!selected) {
          return;
        }
        url = selected.url;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.languages.registerCodeLensProvider(
      GO_LANGUAGE_SELECTOR,
      new EndpointCodeLensProvider(),
    ),
    vscode.commands.registerCommand("encore.showMigrations", async (item?: EncoreTreeItem) => {
      let migrationsDir = item?.migrationsDir;

      if (!migrationsDir) {
        // Called from Command Palette — show a QuickPick with databases that have migrations.
        const databases = databaseStore.getDatabases().filter((db) => db.migrationsDir);
        if (databases.length === 0) {
          vscode.window.showInformationMessage("Encore: no databases with migrations found.");
          return;
        }
        const picks = databases.map((db) => ({
          label: db.name,
          description: db.migrationsDir!,
          migrationsDir: db.migrationsDir!,
        }));
        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select a database to show migrations",
        });
        if (!selected) {
          return;
        }
        migrationsDir = selected.migrationsDir;
      }

      // Find the last migration file (highest numbered) in the directory.
      const dirUri = vscode.Uri.file(migrationsDir);
      try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const sqlFiles = entries
          .filter(([name, type]) =>
            type === vscode.FileType.File && name.endsWith(".sql"),
          )
          .map(([name]) => name)
          .sort();

        const lastFile = sqlFiles.length > 0
          ? sqlFiles[sqlFiles.length - 1]
          : undefined;

        if (lastFile) {
          // Reveal the file in the Explorer sidebar and open it.
          const fileUri = vscode.Uri.joinPath(dirUri, lastFile);
          await vscode.commands.executeCommand("revealInExplorer", fileUri);
          await vscode.commands.executeCommand("vscode.open", fileUri);
        } else {
          // No SQL files — just reveal the directory.
          await vscode.commands.executeCommand("revealInExplorer", dirUri);
        }
      } catch {
        vscode.window.showWarningMessage(
          `Migrations directory not found: ${migrationsDir}`,
        );
      }
    }),
  );

  return treeDataProvider;
}

function registerTestSupport(
  context: vscode.ExtensionContext,
  encoreAppState: EncoreAppState,
): void {
  const controller = registerTestController(context, encoreAppState);
  const testCodeLensProvider = new EncoreTestCodeLensProvider(encoreAppState);

  // CodeLens provider for "Run Test | Debug Test" above test functions.
  context.subscriptions.push(
    testCodeLensProvider,
    vscode.languages.registerCodeLensProvider(
      { language: "go", pattern: "**/*_test.go" },
      testCodeLensProvider,
    ),
  );

  // Command: run a single test function (invoked from CodeLens).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "encore.runTest",
      async (uri: vscode.Uri, funcName: string) => {
        const item = findTestItem(controller, uri, funcName);
        if (!item) {
          vscode.window.showWarningMessage(
            `Encore: test item not found for "${funcName}" — try reloading the window.`,
          );
          return;
        }
        const request = new vscode.TestRunRequest([item]);
        const run = controller.createTestRun(request);
        const tokenSource = new vscode.CancellationTokenSource();
        await runEncoreTests(request, tokenSource.token, controller, run);
        tokenSource.dispose();
      },
    ),
  );

  // Command: debug a single test function (invoked from CodeLens).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "encore.debugTest",
      async (uri: vscode.Uri, funcName: string) => {
        const item = findTestItem(controller, uri, funcName);
        if (!item) {
          vscode.window.showWarningMessage(
            `Encore: test item not found for "${funcName}" — try reloading the window.`,
          );
          return;
        }
        const request = new vscode.TestRunRequest([item]);
        const run = controller.createTestRun(request);
        run.started(item);
        const tokenSource = new vscode.CancellationTokenSource();
        const { started, sessionDone } = await debugEncoreTest(request, tokenSource.token);
        tokenSource.dispose();
        if (started) {
          sessionDone.then((exitCode) => {
            if (exitCode === 0) {
              run.passed(item);
            } else {
              run.failed(item, new vscode.TestMessage("Test failed (exit code " + exitCode + ")"));
            }
            run.end();
          });
        } else {
          run.end();
        }
      },
    ),
  );
}

/**
 * Find a test item in the controller by file URI and test path.
 *
 * testPath can be "TestFoo" for a top-level test function or
 * "TestFoo/subtest name" for a subtest.
 */
function findTestItem(
  controller: vscode.TestController,
  uri: vscode.Uri,
  testPath: string,
): vscode.TestItem | undefined {
  const fileId = createEncoreTestItemId(uri, "file");
  const fileItem = findTestItemRecursive(controller.items, (item) => item.id === fileId);

  if (!fileItem) {
    return undefined;
  }

  for (const kind of ["test", "benchmark", "fuzz"] as const) {
    const funcId = createEncoreTestItemId(uri, kind, testPath);
    const funcItem = fileItem.children.get(funcId);
    if (funcItem) {
      return funcItem;
    }
  }

  const slashIdx = testPath.indexOf("/");
  if (slashIdx !== -1) {
    const parentName = testPath.substring(0, slashIdx);
    for (const kind of ["test", "benchmark", "fuzz"] as const) {
      const parentId = createEncoreTestItemId(uri, kind, parentName);
      const parentItem = fileItem.children.get(parentId);
      if (parentItem) {
        const { kind: parentKind } = parseEncoreTestItemId(parentItem.id);
        const subId = createEncoreTestItemId(uri, parentKind, testPath);
        return parentItem.children.get(subId);
      }
    }
  }

  return undefined;
}

function findTestItemRecursive(
  items: vscode.TestItemCollection,
  predicate: (item: vscode.TestItem) => boolean,
): vscode.TestItem | undefined {
  let match: vscode.TestItem | undefined;

  items.forEach((item) => {
    if (match) {
      return;
    }

    if (predicate(item)) {
      match = item;
      return;
    }

    match = findTestItemRecursive(item.children, predicate);
  });

  return match;
}

// ---------------------------------------------------------------------------
// QuickPick helpers for Command Palette invocations
// ---------------------------------------------------------------------------

interface GoToSourcePickItem extends vscode.QuickPickItem {
  filePath: string;
  line: number;
}

function buildGoToSourcePicks(
  serviceStore: ServiceStore,
  databaseStore: DatabaseStore,
  cacheStore: CacheStore,
  pubsubStore: PubSubStore,
  bucketStore: BucketStore,
  cronStore: CronStore,
): GoToSourcePickItem[] {
  const picks: GoToSourcePickItem[] = [];

  for (const svc of serviceStore.getServices()) {
    if (svc.serviceFilePath) {
      picks.push({
        label: `$(symbol-class) ${svc.name}`,
        description: "service",
        filePath: svc.serviceFilePath,
        line: svc.serviceFileLine ?? 0,
      });
    }
    for (const ep of svc.endpoints) {
      const methods = ep.methods.length > 0 ? ep.methods.join(", ") : "";
      picks.push({
        label: `$(symbol-method) ${svc.name}.${ep.name}`,
        description: `endpoint ${methods} ${ep.path}`.trim(),
        filePath: ep.filePath,
        line: ep.line,
      });
    }
  }

  for (const db of databaseStore.getDatabases()) {
    picks.push({
      label: `$(database) ${db.name}`,
      description: "database",
      filePath: db.filePath,
      line: db.line,
    });
  }

  for (const cluster of cacheStore.getClusters()) {
    picks.push({
      label: `$(archive) ${cluster.clusterName}`,
      description: "cache cluster",
      filePath: cluster.filePath,
      line: cluster.line,
    });
    for (const ks of cluster.keyspaces) {
      picks.push({
        label: `$(key) ${cluster.clusterName}/${ks.name}`,
        description: `keyspace (${ks.constructor})`,
        filePath: ks.filePath,
        line: ks.line,
      });
    }
  }

  for (const topic of pubsubStore.getTopics()) {
    picks.push({
      label: `$(broadcast) ${topic.topicName}`,
      description: `topic (${topic.deliveryGuarantee})`,
      filePath: topic.filePath,
      line: topic.line,
    });
    for (const sub of topic.subscriptions) {
      picks.push({
        label: `$(mail) ${topic.topicName}/${sub.name}`,
        description: "subscription",
        filePath: sub.filePath,
        line: sub.line,
      });
    }
  }

  for (const bucket of bucketStore.getBuckets()) {
    picks.push({
      label: `$(file-binary) ${bucket.bucketName}`,
      description: "object storage bucket",
      filePath: bucket.filePath,
      line: bucket.line,
    });
  }

  for (const job of cronStore.getJobs()) {
    const title = job.title || job.jobId;
    picks.push({
      label: `$(clock) ${title}`,
      description: `cron job (${job.schedule})`,
      filePath: job.filePath,
      line: job.line,
    });
  }

  return picks;
}

interface EndpointConsolePickItem extends vscode.QuickPickItem {
  url: string;
}

const DEFAULT_DASHBOARD_PORT = 9400;

function buildEndpointConsolePicks(
  serviceStore: ServiceStore,
  appId: string,
): EndpointConsolePickItem[] {
  const dashboardBase = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/${appId}`;
  const picks: EndpointConsolePickItem[] = [];

  for (const svc of serviceStore.getServices()) {
    const serviceName = path.basename(svc.dirPath).replace(/-/g, "");
    for (const ep of svc.endpoints) {
      const methods = ep.methods.length > 0 ? ep.methods.join(", ") : "";
      picks.push({
        label: `${svc.name}.${ep.name}`,
        description: `${methods} ${ep.path}`.trim(),
        url: `${dashboardBase}/envs/local/api/${serviceName}/${ep.name}`,
      });
    }
  }

  return picks;
}

/**
 * Read the app ID from the first encore.app file found in the workspace.
 * Returns undefined if the file cannot be found or parsed.
 */
async function readAppId(): Promise<string | undefined> {
  const encoreAppFiles = await findEncoreAppFiles();
  if (encoreAppFiles.length === 0) {
    return undefined;
  }

  try {
    const raw = fs.readFileSync(encoreAppFiles[0].fsPath, "utf-8");
    const idMatch = raw.match(/"id"\s*:\s*"([^"]+)"/);
    return idMatch ? idMatch[1] : undefined;
  } catch {
    return undefined;
  }
}

async function findEncoreAppFiles(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles(
    "**/encore.app",
    ENCORE_APP_EXCLUDE_GLOB,
  );
}

export function deactivate(): void {
  // No cleanup needed.
}

function collectEncoreAppRootPaths(
  encoreAppFiles: readonly vscode.Uri[],
): string[] {
  const encoreAppRootPaths = new Set<string>();

  for (const encoreAppFile of encoreAppFiles) {
    encoreAppRootPaths.add(path.dirname(encoreAppFile.fsPath));
  }

  return Array.from(encoreAppRootPaths).sort((left, right) =>
    left.localeCompare(right),
  );
}
