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
import { AppRunner, AppState } from "./runner/appRunner";
import { AppRunnerRegistry } from "./runner/appRunnerRegistry";
import { AppStatusBarManager } from "./runner/statusBar";
import { GO_FILE_EXCLUDE_GLOB, isVisibleWorkspaceFile } from "./utils/workspaceScan";
import { buildEncoreEnv, isEncoreCliAvailable, promptMissingCli } from "./utils/encoreEnv";
import { EncoreAppState } from "./utils/encoreAppState";
import { DiscoveredApp, discoverApps } from "./utils/discoveredApps";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const goFileWatcher = new GoFileWatcher();
  const encoreAppWatcher = vscode.workspace.createFileSystemWatcher("**/encore.app");
  const goModWatcher = vscode.workspace.createFileSystemWatcher("**/go.mod");
  const encoreAppState = new EncoreAppState();
  const appRunnerRegistry = new AppRunnerRegistry(encoreAppState);
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
    appRunnerRegistry,
  );

  const initialDiscoveredApps = await discoverApps();
  applyDiscoveredApps(initialDiscoveredApps, encoreAppState, secretStore);

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
    appRunnerRegistry,
    encoreAppState,
  );
  registerTestSupport(context, encoreAppState);

  const refreshEncoreWorkspaceState = async (): Promise<void> => {
    const discoveredApps = await discoverApps();
    applyDiscoveredApps(discoveredApps, encoreAppState, secretStore);

    const isEncoreWorkspace = discoveredApps.length > 0;
    await vscode.commands.executeCommand(
      "setContext",
      "encore.isEncoreWorkspace",
      isEncoreWorkspace,
    );
    treeDataProvider.refreshProjectState();

    if (!isEncoreWorkspace) {
      return;
    }

    for (const app of discoveredApps) {
      databaseStore.fetchAllConnUrisForApp(app.rootPath);
    }
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

function applyDiscoveredApps(
  discoveredApps: readonly DiscoveredApp[],
  encoreAppState: EncoreAppState,
  secretStore: SecretStore,
): void {
  encoreAppState.setDiscoveredApps(discoveredApps);
  secretStore.setDiscoveredAppRoots(discoveredApps.map((app) => app.rootPath));
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
  appRunnerRegistry: AppRunnerRegistry,
  encoreAppState: EncoreAppState,
): EncoreTreeDataProvider {
  const appStatusBar = new AppStatusBarManager(appRunnerRegistry);

  const treeDataProvider = new EncoreTreeDataProvider(
    secretStore, serviceStore, cacheStore, databaseStore, pubsubStore, bucketStore, cronStore,
    appRunnerRegistry,
    encoreAppState,
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

  /**
   * Pick an Encore app via QuickPick when a command is invoked without an
   * explicit target (e.g. from the Command Palette).
   *
   * Strategy: if only one app is discovered, return it. Otherwise, show a
   * QuickPick filtered by `candidateFilter` (defaults to "any discovered app").
   * Returns the chosen AppRunner or undefined if the user cancels.
   */
  async function pickApp(
    placeholder: string,
    candidateFilter: (runner: AppRunner) => boolean = () => true,
  ): Promise<AppRunner | undefined> {
    const candidates = appRunnerRegistry.getAll().filter(candidateFilter);
    if (candidates.length === 0) {
      vscode.window.showInformationMessage(
        "Encore: no matching Encore applications available.",
      );
      return undefined;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    const items = candidates.map((runner) => ({
      label: runner.displayName,
      description: runner.appRootPath,
      runner,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
    return selected?.runner;
  }

  context.subscriptions.push(
    treeView,
    appStatusBar,
    treeDataProvider.startPolling(),
    vscode.commands.registerCommand("encore.refreshExplorer", () => {
      treeDataProvider.refresh();
    }),
    vscode.commands.registerCommand("encore.goToSource", async (item?: EncoreTreeItem) => {
      let filePath = item?.sourceFilePath;
      let line = item?.sourceFileLine ?? 0;

      if (!filePath) {
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
    vscode.commands.registerCommand("encore.copyDbConnUri", async (item?: EncoreTreeItem) => {
      let dbName = item?.dataKey;
      let appRootPath = item?.appRootPath;

      if (!dbName || !appRootPath) {
        type DbPick = vscode.QuickPickItem & { dbName: string; appRootPath: string };
        const picks: DbPick[] = [];
        for (const app of encoreAppState.getDiscoveredApps()) {
          for (const db of databaseStore.getDatabases()) {
            if (!isFileInsideAppRoot(db.filePath, app.rootPath)) {
              continue;
            }
            picks.push({
              label: db.name,
              description: app.displayName,
              dbName: db.name,
              appRootPath: app.rootPath,
            });
          }
        }
        if (picks.length === 0) {
          vscode.window.showInformationMessage("Encore: no databases found.");
          return;
        }
        const selected = await vscode.window.showQuickPick(picks, {
          placeHolder: "Select a database to copy connection URI",
        });
        if (!selected) {
          return;
        }
        dbName = selected.dbName;
        appRootPath = selected.appRootPath;
      }

      const connUri = databaseStore.getConnUri(appRootPath, dbName);
      if (!connUri) {
        vscode.window.showWarningMessage(
          `Encore: connection URI not available for "${dbName}". Is the application running?`,
        );
        return;
      }
      vscode.env.clipboard.writeText(connUri).then(() => {
        vscode.window.setStatusBarMessage(
          `$(check) Copied connection URI for "${dbName}"`,
          3000,
        );
      });
    }),
    vscode.commands.registerCommand("encore.runApp", async (item?: EncoreTreeItem) => {
      const runner = await resolveAppForAction(
        appRunnerRegistry,
        item,
        "Select an Encore application to run",
        (candidate) => candidate.getState() === AppState.Stopped,
        pickApp,
      );
      if (!runner) {
        return;
      }
      runner.run(readRunOptions(false));
    }),
    vscode.commands.registerCommand("encore.debugApp", async (item?: EncoreTreeItem) => {
      const runner = await resolveAppForAction(
        appRunnerRegistry,
        item,
        "Select an Encore application to debug",
        (candidate) => candidate.getState() === AppState.Stopped,
        pickApp,
      );
      if (!runner) {
        return;
      }
      runner.run(readRunOptions(true));
    }),
    vscode.commands.registerCommand("encore.stopApp", async (item?: EncoreTreeItem) => {
      const runner = await resolveAppForAction(
        appRunnerRegistry,
        item,
        "Select an Encore application to stop",
        (candidate) =>
          candidate.getState() !== AppState.Stopped
          && candidate.getState() !== AppState.Stopping,
        pickApp,
      );
      if (!runner) {
        return;
      }
      runner.stop();
    }),
    vscode.commands.registerCommand("encore.restartApp", async (item?: EncoreTreeItem) => {
      const runner = await resolveAppForAction(
        appRunnerRegistry,
        item,
        "Select an Encore application to restart",
        (candidate) =>
          candidate.getState() === AppState.Running
          || candidate.getState() === AppState.Debugging,
        pickApp,
      );
      if (!runner) {
        return;
      }
      runner.restart();
    }),
    vscode.commands.registerCommand("encore.showAppOutput", async (item?: EncoreTreeItem) => {
      const runner = await resolveAppForAction(
        appRunnerRegistry,
        item,
        "Select an Encore application to view output",
        () => true,
        pickApp,
      );
      runner?.showOutput();
    }),
    vscode.commands.registerCommand(
      "encore.showAppOutputForApp",
      (appRootPath?: string) => {
        if (!appRootPath) {
          return;
        }
        const runner = appRunnerRegistry.get(appRootPath);
        runner?.showOutput();
      },
    ),
    vscode.commands.registerCommand("encore.openAppUrl", (url: string) => {
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    vscode.commands.registerCommand("encore.openEndpointInConsole", async (url?: string) => {
      if (!url) {
        const apps = encoreAppState.getDiscoveredApps();
        if (apps.length === 0) {
          vscode.window.showWarningMessage(
            "Encore: no Encore applications discovered in the workspace.",
          );
          return;
        }

        type EndpointPick = vscode.QuickPickItem & { url: string };
        const picks: EndpointPick[] = [];
        for (const app of apps) {
          const appId = readAppId(app.encoreAppPath);
          if (!appId) {
            continue;
          }
          for (const pick of buildEndpointConsolePicks(serviceStore, appId, app)) {
            picks.push({
              label: pick.label,
              description: `${pick.description ?? ""} · ${app.displayName}`.trim(),
              url: pick.url,
            });
          }
        }

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
      new EndpointCodeLensProvider(encoreAppState),
    ),
    vscode.commands.registerCommand("encore.showMigrations", async (item?: EncoreTreeItem) => {
      let migrationsDir = item?.migrationsDir;

      if (!migrationsDir) {
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
          const fileUri = vscode.Uri.joinPath(dirUri, lastFile);
          await vscode.commands.executeCommand("revealInExplorer", fileUri);
          await vscode.commands.executeCommand("vscode.open", fileUri);
        } else {
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

async function resolveAppForAction(
  registry: AppRunnerRegistry,
  item: EncoreTreeItem | undefined,
  placeholder: string,
  candidateFilter: (runner: AppRunner) => boolean,
  pickApp: (placeholder: string, filter: (runner: AppRunner) => boolean) => Promise<AppRunner | undefined>,
): Promise<AppRunner | undefined> {
  const appRootPath = item?.appRootPath ?? item?.dataKey;
  if (appRootPath) {
    const runner = registry.get(appRootPath);
    if (runner) {
      return runner;
    }
  }

  return pickApp(placeholder, candidateFilter);
}

function registerTestSupport(
  context: vscode.ExtensionContext,
  encoreAppState: EncoreAppState,
): void {
  const controller = registerTestController(context, encoreAppState);
  const testCodeLensProvider = new EncoreTestCodeLensProvider(encoreAppState);

  context.subscriptions.push(
    testCodeLensProvider,
    vscode.languages.registerCodeLensProvider(
      { language: "go", pattern: "**/*_test.go" },
      testCodeLensProvider,
    ),
  );

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
        await runEncoreTests(request, tokenSource.token, controller, run, encoreAppState);
        tokenSource.dispose();
      },
    ),
  );

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
        const { started, sessionDone } = await debugEncoreTest(request, tokenSource.token, encoreAppState);
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
  app: DiscoveredApp,
): EndpointConsolePickItem[] {
  const dashboardBase = `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/${appId}`;
  const picks: EndpointConsolePickItem[] = [];

  for (const svc of serviceStore.getServices()) {
    if (!isFileInsideAppRoot(svc.dirPath, app.rootPath)) {
      continue;
    }
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

function readAppId(encoreAppPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(encoreAppPath, "utf-8");
    const idMatch = raw.match(/"id"\s*:\s*"([^"]+)"/);
    return idMatch?.[1];
  } catch {
    return undefined;
  }
}

function isFileInsideAppRoot(candidatePath: string, appRootPath: string): boolean {
  const relativePath = path.relative(appRootPath, candidatePath);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function deactivate(): void {
  // No cleanup needed.
}
