import * as vscode from "vscode";
import { exec } from "child_process";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { BucketInfo, BucketStore } from "../encore/bucketStore";
import { CacheClusterInfo, CacheStore, KeyspaceInfo } from "../encore/cacheStore";
import { CronJobInfo, CronStore } from "../encore/cronStore";
import { DatabaseInfo, DatabaseStore } from "../encore/databaseStore";
import { PubSubStore, SubscriptionInfo, TopicInfo } from "../encore/pubsubStore";
import { SecretEntry, SecretStore } from "../encore/secretStore";
import { EndpointInfo, ServiceInfo, ServiceStore } from "../encore/serviceStore";
import { AppState } from "../runner/appRunner";
import { AppRunnerRegistry } from "../runner/appRunnerRegistry";
import { DiscoveredApp, isPathInsideAppRoot as isInsideRoot } from "../utils/discoveredApps";
import { EncoreAppState } from "../utils/encoreAppState";
import { GO_FILE_EXCLUDE_GLOB } from "../utils/workspaceScan";

/** Represents a single node in the Encore explorer tree. */
export class EncoreTreeItem extends vscode.TreeItem {
  /** Optional source file path for "Go to Source" navigation. */
  sourceFilePath?: string;
  /** Optional zero-based line number for "Go to Source" navigation. */
  sourceFileLine?: number;
  /** Optional absolute path to a migrations directory (for database nodes). */
  migrationsDir?: string;
  /**
   * Optional absolute path to the Encore app root this node belongs to.
   * Set on nodes that act on a specific app (run buttons, databases, etc.).
   */
  appRootPath?: string;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeKind: EncoreNodeKind,
    /** Opaque key used to match child lookups (e.g. service dirPath, folder prefix). */
    public readonly dataKey: string = "",
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeKind;
  }
}

export type EncoreNodeKind =
  | "daemonRoot"
  | "daemonStat"
  | "cloudRoot"
  | "appRoot"
  | "servicesGroup"
  | "serviceFolder"
  | "service"
  | "endpoint"
  | "cachesGroup"
  | "cacheCluster"
  | "keyspace"
  | "databasesGroup"
  | "database"
  | "pubsubGroup"
  | "pubsubTopic"
  | "pubsubSubscription"
  | "bucketsGroup"
  | "bucket"
  | "cronJobsGroup"
  | "cronJob"
  | "secretsGroup"
  | "secret"
  | "secretEnv"
  | "appRunRoot"
  | "appRunInfo"
  | "placeholder";

interface DaemonStats {
  processCount: number;
  totalMemoryMB: number;
  totalFileDescriptors: number;
}

/**
 * A node in the service folder tree built from relative directory paths.
 * Intermediate directories that only group services become folder nodes;
 * leaf directories that contain actual services become service nodes.
 */
interface FolderTreeNode {
  /** Directory segment name (e.g. "apis", "web-api"). */
  segment: string;
  /** Full relative path from workspace root (e.g. "apis/web-api"). */
  relativePath: string;
  /** Child folder nodes. */
  children: Map<string, FolderTreeNode>;
  /** Services directly in this directory. */
  services: ServiceInfo[];
}

/**
 * Provides tree data for the Encore explorer panel.
 *
 * Top-level nodes:
 *   Encore Daemon [running/stopped]
 *   ├── Processes: 2
 *   ├── Memory: 245 MB
 *   └── File descriptors: 1,234
 *
 *   Encore Cloud [logged in as user@example.com]
 *
 *   MyApp
 *   ├── Secrets (15)
 *   ├── Endpoints (42)
 *   │   ├── apis/web-api        5 endpoints
 *   │   └── customers           6 endpoints
 *   ├── Databases (3)
 *   ├── Caches (2)
 *   └── Cron Jobs (4)
 */
export class EncoreTreeDataProvider
  implements vscode.TreeDataProvider<EncoreTreeItem>
{
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<EncoreTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private daemonRunning = false;
  private daemonStopping = false;
  private daemonStats: DaemonStats | null = null;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly secretStore: SecretStore;
  private readonly serviceStore: ServiceStore;
  private readonly cacheStore: CacheStore;
  private readonly databaseStore: DatabaseStore;
  private readonly pubsubStore: PubSubStore;
  private readonly bucketStore: BucketStore;
  private readonly cronStore: CronStore;
  private readonly appRunnerRegistry: AppRunnerRegistry;
  private readonly encoreAppState: EncoreAppState;

  /** Cached folder trees keyed by Encore app root path. */
  private folderTrees = new Map<string, FolderTreeNode>();

  constructor(
    secretStore: SecretStore,
    serviceStore: ServiceStore,
    cacheStore: CacheStore,
    databaseStore: DatabaseStore,
    pubsubStore: PubSubStore,
    bucketStore: BucketStore,
    cronStore: CronStore,
    appRunnerRegistry: AppRunnerRegistry,
    encoreAppState: EncoreAppState,
  ) {
    this.secretStore = secretStore;
    this.serviceStore = serviceStore;
    this.cacheStore = cacheStore;
    this.databaseStore = databaseStore;
    this.pubsubStore = pubsubStore;
    this.bucketStore = bucketStore;
    this.cronStore = cronStore;
    this.appRunnerRegistry = appRunnerRegistry;
    this.encoreAppState = encoreAppState;

    this.appRunnerRegistry.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });

    this.encoreAppState.onDidChange(() => {
      this.folderTrees.clear();
      this.onDidChangeTreeDataEmitter.fire();
    });

    this.secretStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.serviceStore.onDidChange(() => {
      this.folderTrees.clear();
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.cacheStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.databaseStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.pubsubStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.bucketStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });
    this.cronStore.onDidChange(() => {
      this.onDidChangeTreeDataEmitter.fire();
    });

    this.checkDaemonStatus();
  }

  private getDiscoveredApps(): readonly DiscoveredApp[] {
    return this.encoreAppState.getDiscoveredApps();
  }

  async refresh(): Promise<void> {
    this.checkDaemonStatus();
    await this.refreshProjectState();
    this.secretStore.refresh();

    // Clear caches and re-scan all Go files.
    this.serviceStore.refresh();
    this.cacheStore.refresh();
    this.databaseStore.refresh();
    this.pubsubStore.refresh();
    this.bucketStore.refresh();
    this.cronStore.refresh();

    const goFiles = await vscode.workspace.findFiles(
      "**/*.go",
      GO_FILE_EXCLUDE_GLOB,
    );
    await Promise.all([
      this.serviceStore.scanFiles(goFiles),
      this.cacheStore.scanFiles(goFiles),
      this.databaseStore.scanFiles(goFiles),
      this.pubsubStore.scanFiles(goFiles),
      this.bucketStore.scanFiles(goFiles),
      this.cronStore.scanFiles(goFiles),
    ]);
  }

  /**
   * Explicit refresh hook kept for the refresh button and daemon-stat cycle.
   * Discovery itself is driven by EncoreAppState subscription in extension.ts;
   * this method only triggers a UI rebuild.
   */
  refreshProjectState(): void {
    this.folderTrees.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** Start periodic daemon status and stats polling. */
  startPolling(intervalMs = 10_000): vscode.Disposable {
    this.pollTimer = setInterval(() => {
      this.pollDaemon();
    }, intervalMs);

    return new vscode.Disposable(() => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    });
  }

  /**
   * Poll daemon status and Encore Cloud auth status in one cycle.
   */
  private pollDaemon(): void {
    this.checkDaemonStatus();
    this.secretStore.refreshAuthStatus();
  }

  getTreeItem(element: EncoreTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EncoreTreeItem): Promise<EncoreTreeItem[]> {
    if (!element) {
      const rootItems = [
        this.buildDaemonNode(),
        this.buildEncoreCloudNode(),
      ];

      const discoveredApps = this.getDiscoveredApps();
      if (discoveredApps.length === 0) {
        rootItems.push(this.buildPlaceholder("No Encore apps found in the project"));
        return rootItems;
      }

      rootItems.push(
        ...discoveredApps.map((app) => this.buildAppNode(app)),
      );
      return rootItems;
    }

    if (element.nodeKind === "daemonRoot") {
      return this.buildDaemonStatChildren();
    }

    if (element.nodeKind === "cloudRoot") {
      return [];
    }

    if (element.nodeKind === "appRoot") {
      const appRootPath = element.dataKey;
      const app = this.getDiscoveredApps().find(
        (candidate) => candidate.rootPath === appRootPath,
      );
      const appChildren: EncoreTreeItem[] = [
        this.buildAppRunNode(appRootPath),
        this.buildServicesGroup(appRootPath),
        this.buildDatabasesGroup(appRootPath),
        this.buildCachesGroup(appRootPath),
        this.buildPubSubGroup(appRootPath),
        this.buildBucketsGroup(appRootPath),
        this.buildCronJobsGroup(appRootPath),
      ];

      if (this.secretStore.isAuthenticated() && app) {
        appChildren.splice(1, 0, this.buildSecretsGroup(app));
      }

      appChildren.sort((left, right) =>
        left.label.toString().localeCompare(right.label.toString()),
      );

      return appChildren;
    }

    if (element.nodeKind === "appRunRoot") {
      return this.buildAppRunChildren(element.appRootPath ?? element.dataKey);
    }

    if (element.nodeKind === "servicesGroup") {
      return this.buildServiceTreeChildren(element.dataKey, "");
    }

    if (element.nodeKind === "serviceFolder") {
      const { appRootPath, folderPath } = parseServiceFolderNodeKey(element.dataKey);
      return this.buildServiceTreeChildren(appRootPath, folderPath);
    }

    if (element.nodeKind === "service") {
      return this.buildEndpointChildren(element.dataKey);
    }

    if (element.nodeKind === "databasesGroup") {
      if (!this.databaseStore.isLoaded()) {
        return [this.buildPlaceholder("Scanning workspace...")];
      }
      const databases = this.getDatabasesForApp(element.dataKey);
      if (databases.length === 0) {
        return [this.buildPlaceholder("No databases found")];
      }
      return databases.map((db) => this.buildDatabaseNode(db, element.dataKey));
    }

    if (element.nodeKind === "cachesGroup") {
      if (!this.cacheStore.isLoaded()) {
        return [this.buildPlaceholder("Scanning workspace...")];
      }
      const clusters = this.getClustersForApp(element.dataKey);
      if (clusters.length === 0) {
        return [this.buildPlaceholder("No cache clusters found")];
      }
      return clusters.map((cluster) => this.buildCacheClusterNode(cluster));
    }

    if (element.nodeKind === "cacheCluster") {
      const clusters = this.cacheStore.getClusters();
      const cluster = clusters.find((c) => c.clusterName === element.dataKey);
      if (!cluster || cluster.keyspaces.length === 0) {
        return [this.buildPlaceholder("No keyspaces")];
      }
      return cluster.keyspaces.map((ks) => this.buildKeyspaceNode(ks));
    }

    if (element.nodeKind === "pubsubGroup") {
      if (!this.pubsubStore.isLoaded()) {
        return [this.buildPlaceholder("Scanning workspace...")];
      }
      const topics = this.getTopicsForApp(element.dataKey);
      if (topics.length === 0) {
        return [this.buildPlaceholder("No Pub/Sub topics found")];
      }
      return topics.map((topic) => this.buildPubSubTopicNode(topic));
    }

    if (element.nodeKind === "pubsubTopic") {
      const topics = this.pubsubStore.getTopics();
      const topic = topics.find((t) => t.topicName === element.dataKey);
      if (!topic || topic.subscriptions.length === 0) {
        return [this.buildPlaceholder("No subscriptions")];
      }
      return topic.subscriptions.map((sub) => this.buildPubSubSubscriptionNode(sub));
    }

    if (element.nodeKind === "bucketsGroup") {
      if (!this.bucketStore.isLoaded()) {
        return [this.buildPlaceholder("Scanning workspace...")];
      }
      const buckets = this.getBucketsForApp(element.dataKey);
      if (buckets.length === 0) {
        return [this.buildPlaceholder("No buckets found")];
      }
      return buckets.map((bucket) => this.buildBucketNode(bucket));
    }

    if (element.nodeKind === "cronJobsGroup") {
      if (!this.cronStore.isLoaded()) {
        return [this.buildPlaceholder("Scanning workspace...")];
      }
      const jobs = this.getJobsForApp(element.dataKey);
      if (jobs.length === 0) {
        return [this.buildPlaceholder("No cron jobs found")];
      }
      return jobs.map((job) => this.buildCronJobNode(job));
    }

    if (element.nodeKind === "secretsGroup") {
      const appRootPath = element.dataKey;
      const secrets = this.secretStore.ensureLoaded(appRootPath);
      if (!this.secretStore.isLoaded(appRootPath)) {
        return [this.buildPlaceholder("Loading secrets...")];
      }
      if (secrets.length === 0) {
        return [this.buildPlaceholder("No secrets found")];
      }
      return secrets.map((secret) => this.buildSecretNode(secret, appRootPath));
    }

    if (element.nodeKind === "secret") {
      const { appRootPath, secretKey } = parseSecretNodeKey(element.dataKey);
      if (!appRootPath || !secretKey) {
        return [];
      }

      const secrets = this.secretStore.getSecrets(appRootPath);
      const secret = secrets.find((candidate) => candidate.key === secretKey);
      if (!secret) {
        return [];
      }
      return this.buildSecretEnvNodes(secret);
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Folder tree
  // ---------------------------------------------------------------------------

  private ensureFolderTree(appRootPath: string): FolderTreeNode {
    const cachedFolderTree = this.folderTrees.get(appRootPath);
    if (cachedFolderTree) {
      return cachedFolderTree;
    }

    const root: FolderTreeNode = {
      segment: "",
      relativePath: "",
      children: new Map(),
      services: [],
    };

    for (const service of this.getServicesForApp(appRootPath)) {
      const rel = path.relative(appRootPath, service.dirPath);
      const segments = rel.split(path.sep);

      let current = root;

      // Walk all segments except the last — those are intermediate folders.
      // The last segment is the service package itself.
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        const relPath = segments.slice(0, i + 1).join(path.sep);
        let child = current.children.get(seg);
        if (!child) {
          child = { segment: seg, relativePath: relPath, children: new Map(), services: [] };
          current.children.set(seg, child);
        }
        current = child;
      }

      current.services.push(service);
    }

    const collapsedTree = collapseTree(root);
    this.folderTrees.set(appRootPath, collapsedTree);
    return collapsedTree;
  }

  /**
   * Build TreeItem children for a given folder path.
   * Empty string = root of the service tree.
   */
  private buildServiceTreeChildren(appRootPath: string, folderPath: string): EncoreTreeItem[] {
    if (!this.serviceStore.isLoaded()) {
      return [this.buildPlaceholder("Scanning workspace...")];
    }

    const tree = this.ensureFolderTree(appRootPath);
    const node = folderPath === "" ? tree : findNode(tree, folderPath);
    if (!node) {
      return [this.buildPlaceholder("No services found")];
    }

    // Mix folders and services into one list, sorted alphabetically by name.
    const entries: Array<{ name: string; kind: "folder"; folder: FolderTreeNode }
      | { name: string; kind: "service"; service: ServiceInfo }> = [];

    for (const folder of node.children.values()) {
      entries.push({ name: folder.segment, kind: "folder", folder });
    }
    for (const service of node.services) {
      entries.push({ name: service.name, kind: "service", service });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const items: EncoreTreeItem[] = entries.map((entry) =>
      entry.kind === "folder"
        ? this.buildFolderNode(appRootPath, entry.folder)
        : this.buildServiceNode(entry.service),
    );

    if (items.length === 0) {
      return [this.buildPlaceholder("No services found")];
    }

    return items;
  }

  private getServicesForApp(appRootPath: string): ServiceInfo[] {
    return this.serviceStore.getServices().filter((service) =>
      isInsideRoot(service.dirPath, appRootPath),
    );
  }

  private getDatabasesForApp(appRootPath: string): DatabaseInfo[] {
    return this.databaseStore.getDatabases().filter((database) =>
      isInsideRoot(database.filePath, appRootPath),
    );
  }

  private getClustersForApp(appRootPath: string): CacheClusterInfo[] {
    return this.cacheStore.getClusters().filter((cluster) =>
      isInsideRoot(cluster.filePath, appRootPath),
    );
  }

  private getTopicsForApp(appRootPath: string): TopicInfo[] {
    return this.pubsubStore.getTopics().filter((topic) =>
      isInsideRoot(topic.filePath, appRootPath),
    );
  }

  private getBucketsForApp(appRootPath: string): BucketInfo[] {
    return this.bucketStore.getBuckets().filter((bucket) =>
      isInsideRoot(bucket.filePath, appRootPath),
    );
  }

  private getJobsForApp(appRootPath: string): CronJobInfo[] {
    return this.cronStore.getJobs().filter((job) =>
      isInsideRoot(job.filePath, appRootPath),
    );
  }

  // ---------------------------------------------------------------------------
  // Node builders — Encore Cloud
  // ---------------------------------------------------------------------------

  private buildEncoreCloudNode(): EncoreTreeItem {
    const authStatus = this.secretStore.getAuthStatus();

    let iconName: string;
    let iconColour: string;

    switch (authStatus.state) {
      case "authenticated":
        iconName = "circle-filled";
        iconColour = "testing.iconPassed";
        break;
      case "unauthenticated":
        iconName = "circle-filled";
        iconColour = "disabledForeground";
        break;
      default:
        iconName = "sync~spin";
        iconColour = "charts.yellow";
        break;
    }

    const cloudNode = new EncoreTreeItem(
      "Cloud",
      vscode.TreeItemCollapsibleState.None,
      "cloudRoot",
    );
    cloudNode.description = authStatus.message;
    cloudNode.tooltip = authStatus.message;
    cloudNode.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(iconColour));
    return cloudNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — daemon
  // ---------------------------------------------------------------------------

  private buildDaemonNode(): EncoreTreeItem {
    let statusLabel: string;
    let contextValue: string;
    let iconName: string;
    let iconColour: string;
    let collapsible: vscode.TreeItemCollapsibleState;

    if (this.daemonStopping) {
      statusLabel = "stopping\u2026";
      contextValue = "daemonStopping";
      iconName = "sync~spin";
      iconColour = "charts.yellow";
      collapsible = vscode.TreeItemCollapsibleState.None;
    } else if (this.daemonRunning) {
      statusLabel = "running";
      contextValue = "daemonRunning";
      iconName = "circle-filled";
      iconColour = "testing.iconPassed";
      collapsible = vscode.TreeItemCollapsibleState.Collapsed;
    } else {
      statusLabel = "stopped";
      contextValue = "daemonStopped";
      iconName = "circle-filled";
      iconColour = "disabledForeground";
      collapsible = vscode.TreeItemCollapsibleState.None;
    }

    const daemonNode = new EncoreTreeItem(
      "Daemon",
      collapsible,
      "daemonRoot",
    );

    daemonNode.contextValue = contextValue;
    daemonNode.description = statusLabel;
    daemonNode.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(iconColour));
    daemonNode.tooltip = statusLabel === "running"
      ? "Encore daemon is running — expand for process details"
      : `Encore daemon is ${statusLabel}`;

    return daemonNode;
  }

  /**
   * Return cached daemon stat nodes.
   * Stats are refreshed every poll cycle (10 s) — no lazy fetching.
   */
  private buildDaemonStatChildren(): EncoreTreeItem[] {
    if (!this.daemonRunning) {
      return [this.buildPlaceholder("Daemon is not running")];
    }

    if (!this.daemonStats) {
      return [this.buildPlaceholder("Loading stats...")];
    }

    return [
      this.buildStatNode("Processes", `${this.daemonStats.processCount}`),
      this.buildStatNode("Memory", `${this.daemonStats.totalMemoryMB} MB`),
      this.buildStatNode("File descriptors", `${this.daemonStats.totalFileDescriptors}`),
    ];
  }

  private buildStatNode(label: string, value: string): EncoreTreeItem {
    const statNode = new EncoreTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      "daemonStat",
    );
    statNode.description = value;
    statNode.iconPath = new vscode.ThemeIcon("dashboard");
    return statNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — application runner
  // ---------------------------------------------------------------------------

  private buildAppRunNode(appRootPath: string): EncoreTreeItem {
    const runner = this.appRunnerRegistry.get(appRootPath);
    const appState = runner?.getState() ?? AppState.Stopped;
    const appInfo = runner?.getInfo() ?? {};

    let statusLabel: string;
    let contextValue: string;
    let iconName: string;
    let iconColour: string;
    let collapsible: vscode.TreeItemCollapsibleState;

    switch (appState) {
      case AppState.Starting:
        statusLabel = appInfo.buildStage
          ? appInfo.buildStage.toLowerCase()
          : "starting\u2026";
        contextValue = "appRunStarting";
        iconName = "sync~spin";
        iconColour = "charts.yellow";
        collapsible = vscode.TreeItemCollapsibleState.None;
        break;
      case AppState.Running:
        statusLabel = appInfo.baseUrl
          ? `running on :${new URL(appInfo.baseUrl).port}`
          : "running";
        contextValue = "appRunRunning";
        iconName = "circle-filled";
        iconColour = "testing.iconPassed";
        collapsible = vscode.TreeItemCollapsibleState.Expanded;
        break;
      case AppState.Debugging:
        statusLabel = appInfo.baseUrl
          ? `debugging on :${new URL(appInfo.baseUrl).port}`
          : "debugging";
        contextValue = "appRunDebugging";
        iconName = "debug-alt";
        iconColour = "charts.orange";
        collapsible = vscode.TreeItemCollapsibleState.Expanded;
        break;
      case AppState.Stopping:
        statusLabel = "stopping\u2026";
        contextValue = "appRunStopping";
        iconName = "sync~spin";
        iconColour = "charts.yellow";
        collapsible = vscode.TreeItemCollapsibleState.None;
        break;
      default:
        statusLabel = "stopped";
        contextValue = "appRunStopped";
        iconName = "circle-filled";
        iconColour = "disabledForeground";
        collapsible = vscode.TreeItemCollapsibleState.None;
        break;
    }

    const node = new EncoreTreeItem(
      "Application",
      collapsible,
      "appRunRoot",
      appRootPath,
    );
    node.appRootPath = appRootPath;
    node.contextValue = contextValue;
    node.description = statusLabel;
    node.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor(iconColour));
    node.tooltip = `Application is ${statusLabel}`;
    return node;
  }

  private buildAppRunChildren(appRootPath: string): EncoreTreeItem[] {
    const runner = this.appRunnerRegistry.get(appRootPath);
    const info = runner?.getInfo() ?? {};
    const children: EncoreTreeItem[] = [];

    if (info.baseUrl) {
      const urlNode = new EncoreTreeItem(
        `API: ${info.baseUrl}`,
        vscode.TreeItemCollapsibleState.None,
        "appRunInfo",
      );
      urlNode.iconPath = new vscode.ThemeIcon("globe");
      urlNode.tooltip = "Click to open API URL in browser";
      urlNode.command = {
        command: "encore.openAppUrl",
        title: "Open API URL",
        arguments: [info.baseUrl],
      };
      children.push(urlNode);
    }

    if (info.dashboardUrl) {
      const dashNode = new EncoreTreeItem(
        `Dashboard: ${info.dashboardUrl}`,
        vscode.TreeItemCollapsibleState.None,
        "appRunInfo",
      );
      dashNode.iconPath = new vscode.ThemeIcon("dashboard");
      dashNode.tooltip = "Click to open Development Dashboard in browser";
      dashNode.command = {
        command: "encore.openAppUrl",
        title: "Open Dashboard",
        arguments: [info.dashboardUrl],
      };
      children.push(dashNode);
    }

    if (info.pid) {
      const pidNode = new EncoreTreeItem(
        `PID: ${info.pid}`,
        vscode.TreeItemCollapsibleState.None,
        "appRunInfo",
      );
      pidNode.iconPath = new vscode.ThemeIcon("symbol-number");
      children.push(pidNode);
    }

    return children;
  }

  // ---------------------------------------------------------------------------
  // Node builders — app root, services
  // ---------------------------------------------------------------------------

  private buildAppNode(app: DiscoveredApp): EncoreTreeItem {
    const appNode = new EncoreTreeItem(
      app.displayName,
      vscode.TreeItemCollapsibleState.Expanded,
      "appRoot",
      app.rootPath,
    );
    appNode.appRootPath = app.rootPath;
    appNode.description = app.statusMessage;
    appNode.iconPath = new vscode.ThemeIcon(
      app.statusMessage ? "warning" : "symbol-module",
      app.statusMessage
        ? new vscode.ThemeColor("charts.yellow")
        : undefined,
    );
    appNode.tooltip = app.statusMessage
      ? `${app.displayName}\n${app.statusMessage}\n${app.encoreAppPath}`
      : `${app.displayName}\n${app.encoreAppPath}`;
    return appNode;
  }

  private buildServicesGroup(appRootPath: string): EncoreTreeItem {
    const services = this.getServicesForApp(appRootPath);
    const count = this.serviceStore.isLoaded() ? ` (${services.length})` : "";
    const servicesNode = new EncoreTreeItem(
      `Endpoints${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "servicesGroup",
      appRootPath,
    );
    servicesNode.iconPath = new vscode.ThemeIcon("server");
    return servicesNode;
  }

  private buildFolderNode(appRootPath: string, folder: FolderTreeNode): EncoreTreeItem {
    const totalServices = countServices(folder);
    const folderNode = new EncoreTreeItem(
      folder.segment,
      vscode.TreeItemCollapsibleState.Collapsed,
      "serviceFolder",
      encodeServiceFolderNodeKey(appRootPath, folder.relativePath),
    );
    folderNode.iconPath = new vscode.ThemeIcon("folder");
    folderNode.description = `${totalServices}`;
    return folderNode;
  }

  private buildServiceNode(service: ServiceInfo): EncoreTreeItem {
    const endpointCount = service.endpoints.length;
    const desc = endpointCount === 1
      ? "1 endpoint"
      : `${endpointCount} endpoints`;

    const hasEndpoints = endpointCount > 0;
    const serviceNode = new EncoreTreeItem(
      service.name,
      hasEndpoints
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      "service",
      service.dirPath,
    );
    serviceNode.iconPath = new vscode.ThemeIcon("package");
    serviceNode.description = desc;
    serviceNode.tooltip = `${service.name} — ${desc}\n${service.dirPath}`;
    serviceNode.resourceUri = vscode.Uri.file(service.dirPath);

    // Set source location for "Go to Source" navigation.
    // Prefer the //encore:service directive; fall back to the first endpoint file.
    if (service.serviceFilePath) {
      serviceNode.sourceFilePath = service.serviceFilePath;
      serviceNode.sourceFileLine = service.serviceFileLine ?? 0;
    } else if (service.endpoints.length > 0) {
      serviceNode.sourceFilePath = service.endpoints[0].filePath;
      serviceNode.sourceFileLine = service.endpoints[0].line;
    }

    return serviceNode;
  }

  private buildEndpointChildren(serviceDirPath: string): EncoreTreeItem[] {
    const services = this.serviceStore.getServices();
    const service = services.find((s) => s.dirPath === serviceDirPath);
    if (!service || service.endpoints.length === 0) {
      return [this.buildPlaceholder("No endpoints")];
    }
    return service.endpoints.map((ep) => this.buildEndpointNode(ep));
  }

  private buildEndpointNode(endpoint: EndpointInfo): EncoreTreeItem {
    const methodStr = endpoint.methods.length > 0
      ? endpoint.methods.join(",")
      : "";
    const parts: string[] = [];
    if (endpoint.access) { parts.push(endpoint.access); }
    if (endpoint.raw) { parts.push("raw"); }
    if (methodStr) { parts.push(methodStr); }
    if (endpoint.path) { parts.push(endpoint.path); }

    const endpointNode = new EncoreTreeItem(
      endpoint.name,
      vscode.TreeItemCollapsibleState.None,
      "endpoint",
    );
    endpointNode.description = parts.join("  ");
    endpointNode.iconPath = endpointIcon(endpoint);
    endpointNode.tooltip = `${endpoint.name}\n${parts.join(" ")}\n${endpoint.filePath}:${endpoint.line + 1}`;

    endpointNode.command = {
      command: "vscode.open",
      title: "Open endpoint",
      arguments: [
        vscode.Uri.file(endpoint.filePath),
        { selection: new vscode.Range(endpoint.line, 0, endpoint.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return endpointNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — secrets
  // ---------------------------------------------------------------------------

  private buildSecretsGroup(app: DiscoveredApp): EncoreTreeItem {
    const secrets = this.secretStore.getSecrets(app.rootPath);
    const count = this.secretStore.isLoaded(app.rootPath) ? ` (${secrets.length})` : "";
    const secretsNode = new EncoreTreeItem(
      `Secrets${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "secretsGroup",
      app.rootPath,
    );
    secretsNode.iconPath = new vscode.ThemeIcon("lock");
    secretsNode.tooltip = `${app.displayName}\n${app.rootPath}`;
    return secretsNode;
  }

  private buildSecretNode(secret: SecretEntry, appRootPath: string): EncoreTreeItem {
    const envSummary = buildEnvSummary(secret);

    const secretNode = new EncoreTreeItem(
      secret.key,
      vscode.TreeItemCollapsibleState.Collapsed,
      "secret",
      encodeSecretNodeKey(appRootPath, secret.key),
    );
    secretNode.iconPath = new vscode.ThemeIcon("key");
    secretNode.description = envSummary;
    secretNode.tooltip = `${secret.key}\n${envSummary}`;
    return secretNode;
  }

  private buildSecretEnvNodes(secret: SecretEntry): EncoreTreeItem[] {
    const standardEnvs: Array<{ name: string; configured: boolean }> = [
      { name: "Production", configured: secret.environments.production },
      { name: "Development", configured: secret.environments.development },
      { name: "Local", configured: secret.environments.local },
      { name: "Preview", configured: secret.environments.preview },
    ];

    return standardEnvs.map(({ name, configured }) => {
      const indicator = configured ? "\u2713" : "\u2717";
      const envNode = new EncoreTreeItem(
        `${name} ${indicator}`,
        vscode.TreeItemCollapsibleState.None,
        "secretEnv",
      );
      envNode.iconPath = new vscode.ThemeIcon(
        configured ? "pass" : "circle-slash",
        new vscode.ThemeColor(
          configured ? "testing.iconPassed" : "disabledForeground",
        ),
      );
      return envNode;
    });
  }

  // ---------------------------------------------------------------------------
  // Node builders — databases
  // ---------------------------------------------------------------------------

  private buildDatabasesGroup(appRootPath: string): EncoreTreeItem {
    const databases = this.getDatabasesForApp(appRootPath);
    const count = this.databaseStore.isLoaded() ? ` (${databases.length})` : "";
    const dbNode = new EncoreTreeItem(
      `Databases${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "databasesGroup",
      appRootPath,
    );
    dbNode.iconPath = new vscode.ThemeIcon("database");
    return dbNode;
  }

  private buildDatabaseNode(database: DatabaseInfo, appRootPath: string): EncoreTreeItem {
    const dbNode = new EncoreTreeItem(
      database.name,
      vscode.TreeItemCollapsibleState.None,
      "database",
      database.name,
    );
    dbNode.appRootPath = appRootPath;
    dbNode.iconPath = new vscode.ThemeIcon("database");
    dbNode.tooltip = `Database: ${database.name}\n${database.filePath}:${database.line + 1}`;
    dbNode.sourceFilePath = database.filePath;
    dbNode.sourceFileLine = database.line;

    // Build contextValue from available features so menu visibility
    // rules in package.json can show/hide individual inline buttons.
    const hasConnUri = this.databaseStore.getConnUri(appRootPath, database.name) !== undefined;
    const hasMigrations = database.migrationsDir !== undefined;
    if (hasMigrations) {
      dbNode.migrationsDir = database.migrationsDir;
    }
    // Possible values: database, databaseWithConn, databaseWithMigrations, databaseWithConnAndMigrations
    const connPart = hasConnUri ? "WithConn" : "";
    const migPart = hasMigrations ? "AndMigrations" : "";
    if (hasConnUri || hasMigrations) {
      dbNode.contextValue = `database${connPart}${migPart}`;
    }

    dbNode.command = {
      command: "vscode.open",
      title: "Open database declaration",
      arguments: [
        vscode.Uri.file(database.filePath),
        { selection: new vscode.Range(database.line, 0, database.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return dbNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — caches
  // ---------------------------------------------------------------------------

  private buildCachesGroup(appRootPath: string): EncoreTreeItem {
    const clusters = this.getClustersForApp(appRootPath);
    const count = this.cacheStore.isLoaded() ? ` (${clusters.length})` : "";
    const cachesNode = new EncoreTreeItem(
      `Caches${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "cachesGroup",
      appRootPath,
    );
    cachesNode.iconPath = new vscode.ThemeIcon("database");
    return cachesNode;
  }

  private buildCacheClusterNode(cluster: CacheClusterInfo): EncoreTreeItem {
    const ksCount = cluster.keyspaces.length;
    const desc = ksCount === 1
      ? "1 keyspace"
      : `${ksCount} keyspaces`;

    const clusterNode = new EncoreTreeItem(
      cluster.clusterName,
      ksCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      "cacheCluster",
      cluster.clusterName,
    );
    clusterNode.iconPath = new vscode.ThemeIcon("database");
    clusterNode.description = desc;
    clusterNode.tooltip = `Cache cluster: ${cluster.clusterName}\nVariable: ${cluster.varName}\n${cluster.filePath}:${cluster.line + 1}`;
    clusterNode.sourceFilePath = cluster.filePath;
    clusterNode.sourceFileLine = cluster.line;
    return clusterNode;
  }

  private buildKeyspaceNode(keyspace: KeyspaceInfo): EncoreTreeItem {
    const keyspaceNode = new EncoreTreeItem(
      keyspace.name,
      vscode.TreeItemCollapsibleState.None,
      "keyspace",
    );
    keyspaceNode.iconPath = new vscode.ThemeIcon("symbol-field");
    keyspaceNode.description = keyspace.constructor;
    keyspaceNode.tooltip = `${keyspace.name}\n${keyspace.constructor}\n${keyspace.filePath}:${keyspace.line + 1}`;

    keyspaceNode.command = {
      command: "vscode.open",
      title: "Open keyspace declaration",
      arguments: [
        vscode.Uri.file(keyspace.filePath),
        { selection: new vscode.Range(keyspace.line, 0, keyspace.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return keyspaceNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — object storage
  // ---------------------------------------------------------------------------

  private buildBucketsGroup(appRootPath: string): EncoreTreeItem {
    const buckets = this.getBucketsForApp(appRootPath);
    const count = this.bucketStore.isLoaded() ? ` (${buckets.length})` : "";
    const bucketsNode = new EncoreTreeItem(
      `Object Storage${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "bucketsGroup",
      appRootPath,
    );
    bucketsNode.iconPath = new vscode.ThemeIcon("archive");
    return bucketsNode;
  }

  private buildBucketNode(bucket: BucketInfo): EncoreTreeItem {
    const flags: string[] = [];
    if (bucket.isPublic) { flags.push("public"); }
    if (bucket.isVersioned) { flags.push("versioned"); }

    const bucketNode = new EncoreTreeItem(
      bucket.bucketName,
      vscode.TreeItemCollapsibleState.None,
      "bucket",
      bucket.bucketName,
    );
    bucketNode.iconPath = new vscode.ThemeIcon("archive");
    bucketNode.description = flags.join(", ");
    bucketNode.tooltip = `Bucket: ${bucket.bucketName}\nVariable: ${bucket.varName}\n${flags.length > 0 ? flags.join(", ") + "\n" : ""}${bucket.filePath}:${bucket.line + 1}`;
    bucketNode.sourceFilePath = bucket.filePath;
    bucketNode.sourceFileLine = bucket.line;

    bucketNode.command = {
      command: "vscode.open",
      title: "Open bucket declaration",
      arguments: [
        vscode.Uri.file(bucket.filePath),
        { selection: new vscode.Range(bucket.line, 0, bucket.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return bucketNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — cron jobs
  // ---------------------------------------------------------------------------

  private buildCronJobsGroup(appRootPath: string): EncoreTreeItem {
    const jobs = this.getJobsForApp(appRootPath);
    const count = this.cronStore.isLoaded() ? ` (${jobs.length})` : "";
    const cronNode = new EncoreTreeItem(
      `Cron Jobs${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "cronJobsGroup",
      appRootPath,
    );
    cronNode.iconPath = new vscode.ThemeIcon("clock");
    return cronNode;
  }

  private buildCronJobNode(job: CronJobInfo): EncoreTreeItem {
    const cronNode = new EncoreTreeItem(
      job.title || job.jobId,
      vscode.TreeItemCollapsibleState.None,
      "cronJob",
      job.jobId,
    );
    cronNode.iconPath = new vscode.ThemeIcon("clock");
    cronNode.description = job.schedule;
    cronNode.tooltip = `Cron job: ${job.jobId}\n${job.title ? `Title: ${job.title}\n` : ""}Schedule: ${job.schedule || "unknown"}\n${job.filePath}:${job.line + 1}`;
    cronNode.sourceFilePath = job.filePath;
    cronNode.sourceFileLine = job.line;

    cronNode.command = {
      command: "vscode.open",
      title: "Open cron job declaration",
      arguments: [
        vscode.Uri.file(job.filePath),
        { selection: new vscode.Range(job.line, 0, job.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return cronNode;
  }

  // ---------------------------------------------------------------------------
  // Node builders — Pub/Sub
  // ---------------------------------------------------------------------------

  private buildPubSubGroup(appRootPath: string): EncoreTreeItem {
    const topics = this.getTopicsForApp(appRootPath);
    const count = this.pubsubStore.isLoaded() ? ` (${topics.length})` : "";
    const pubsubNode = new EncoreTreeItem(
      `Pub/Sub${count}`,
      vscode.TreeItemCollapsibleState.Collapsed,
      "pubsubGroup",
      appRootPath,
    );
    pubsubNode.iconPath = new vscode.ThemeIcon("radio-tower");
    return pubsubNode;
  }

  private buildPubSubTopicNode(topic: TopicInfo): EncoreTreeItem {
    const subCount = topic.subscriptions.length;
    const subDesc = subCount === 1
      ? "1 subscription"
      : `${subCount} subscriptions`;
    const guaranteeDesc = topic.deliveryGuarantee
      ? `${topic.deliveryGuarantee}`
      : "";
    const descParts = [subDesc];
    if (guaranteeDesc) {
      descParts.push(guaranteeDesc);
    }

    const topicNode = new EncoreTreeItem(
      topic.topicName,
      subCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      "pubsubTopic",
      topic.topicName,
    );
    topicNode.iconPath = new vscode.ThemeIcon("mail");
    topicNode.description = descParts.join("  ");
    topicNode.tooltip = `Topic: ${topic.topicName}\nVariable: ${topic.varName}\nDelivery: ${topic.deliveryGuarantee || "unknown"}\n${topic.filePath}:${topic.line + 1}`;
    topicNode.sourceFilePath = topic.filePath;
    topicNode.sourceFileLine = topic.line;
    return topicNode;
  }

  private buildPubSubSubscriptionNode(sub: SubscriptionInfo): EncoreTreeItem {
    const subNode = new EncoreTreeItem(
      sub.name,
      vscode.TreeItemCollapsibleState.None,
      "pubsubSubscription",
    );
    subNode.iconPath = new vscode.ThemeIcon("plug");
    subNode.tooltip = `Subscription: ${sub.name}\n${sub.filePath}:${sub.line + 1}`;
    subNode.sourceFilePath = sub.filePath;
    subNode.sourceFileLine = sub.line;

    subNode.command = {
      command: "vscode.open",
      title: "Open subscription declaration",
      arguments: [
        vscode.Uri.file(sub.filePath),
        { selection: new vscode.Range(sub.line, 0, sub.line, 0) } as vscode.TextDocumentShowOptions,
      ],
    };

    return subNode;
  }

  private buildPlaceholder(text: string): EncoreTreeItem {
    const placeholderNode = new EncoreTreeItem(
      text,
      vscode.TreeItemCollapsibleState.None,
      "placeholder",
    );
    placeholderNode.iconPath = new vscode.ThemeIcon("info");
    return placeholderNode;
  }

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------

  /**
   * Check whether the Encore daemon is running by attempting a TCP
   * connect() to the daemon Unix socket.
   *
   * Previous implementation ran `encore daemon status` via exec() every
   * 10 seconds. The Encore CLI auto-starts the daemon as a side-effect
   * of any command, so each poll spawned a new daemon process when none
   * was running. Over time the leaked daemon processes exhausted the
   * system file descriptor limit (kern.maxfiles), breaking gopls and
   * every other tool that needs to open files.
   *
   * The socket-based check is non-destructive: connect() succeeds if
   * the daemon is listening, and fails with ECONNREFUSED or ENOENT
   * if the daemon is not running — without spawning any process.
   */
  private checkDaemonStatus(): void {
    const socketPath = encoreDaemonSocketPath();

    const socket = net.createConnection({ path: socketPath }, () => {
      socket.destroy();
      this.updateDaemonRunning(true);
    });

    socket.on("error", () => {
      socket.destroy();
      this.updateDaemonRunning(false);
    });

    socket.setTimeout(2_000, () => {
      socket.destroy();
      this.updateDaemonRunning(false);
    });
  }

  /**
   * Kill all Encore daemon processes and wait until none remain.
   * Shows "stopping" in the tree while waiting.
   */
  async killDaemon(): Promise<void> {
    this.daemonStopping = true;
    this.daemonStats = null;
    this.onDidChangeTreeDataEmitter.fire();

    // Send SIGTERM to the main daemon process and all child processes in the
    // same process group. Using -P (parent) flag to also match children.
    await execAsync("pkill -f 'encore daemon'", 5_000);

    // Poll until all daemon processes are gone (max ~5 seconds).
    for (let attempt = 0; attempt < 10; attempt++) {
      const pids = await execAsync("pgrep -f 'encore daemon'", 2_000);
      if (!pids || pids.trim().length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.daemonStopping = false;
    this.daemonRunning = false;
    this.onDidChangeTreeDataEmitter.fire();
  }

  private updateDaemonRunning(running: boolean): void {
    const wasRunning = this.daemonRunning;
    this.daemonRunning = running;

    if (running) {
      // Fetch stats in the background and refresh the tree when done.
      fetchDaemonStats().then((stats) => {
        const changed = !statsEqual(this.daemonStats, stats);
        this.daemonStats = stats;
        if (changed || this.daemonRunning !== wasRunning) {
          this.onDidChangeTreeDataEmitter.fire();
        }
      });
    } else {
      this.daemonStats = null;
      if (this.daemonRunning !== wasRunning) {
        this.onDidChangeTreeDataEmitter.fire();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon stats
// ---------------------------------------------------------------------------

/** Compare two DaemonStats for equality (used to avoid unnecessary tree refreshes). */
function statsEqual(a: DaemonStats | null, b: DaemonStats | null): boolean {
  if (a === b) { return true; }
  if (!a || !b) { return false; }
  return a.processCount === b.processCount
    && a.totalMemoryMB === b.totalMemoryMB
    && a.totalFileDescriptors === b.totalFileDescriptors;
}

/**
 * Fetch daemon process statistics using system tools (pgrep, ps, lsof).
 * Returns null if the stats cannot be determined.
 */
async function fetchDaemonStats(): Promise<DaemonStats | null> {
  // The daemon runs as "encore daemon -f", not "encored".
  const pids = await execAsync("pgrep -f 'encore daemon'", 5_000);
  if (pids === null) {
    return null;
  }

  const pidList = pids.trim().split("\n").filter((p) => p.length > 0);
  if (pidList.length === 0) {
    return null;
  }

  const pidArg = pidList.join(",");

  // Fetch RSS (in KB) for each daemon process.
  const rssOutput = await execAsync(`ps -o rss= -p ${pidArg}`, 5_000);
  let totalMemoryMB = 0;
  if (rssOutput) {
    const rssValues = rssOutput.trim().split("\n").filter((v) => v.trim().length > 0);
    const totalKB = rssValues.reduce((sum, v) => sum + parseInt(v.trim(), 10), 0);
    totalMemoryMB = Math.round(totalKB / 1024);
  }

  // Count open file descriptors using lsof.
  // Use -F f (field output) for faster parsing than default lsof output.
  const fdCountOutput = await execAsync(
    `lsof -p ${pidArg} -F f 2>/dev/null | grep -c '^f'`,
    15_000,
  );
  let totalFileDescriptors = 0;
  if (fdCountOutput) {
    totalFileDescriptors = parseInt(fdCountOutput.trim(), 10) || 0;
  }

  return {
    processCount: pidList.length,
    totalMemoryMB,
    totalFileDescriptors,
  };
}

function execAsync(command: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Folder tree helpers
// ---------------------------------------------------------------------------

/**
 * Collapse the folder tree to reduce visual noise:
 *
 * 1. Single-child pass-through folders: if a folder has zero services and
 *    exactly one child folder, merge the child into the parent
 *    (e.g. "apis" / "web-api" → "apis/web-api").
 *
 * 2. Single-service folders: if a folder has exactly one service and zero
 *    child folders, promote the service into the parent and remove the folder.
 */
function collapseTree(node: FolderTreeNode): FolderTreeNode {
  // Recursively collapse children first.
  const collapsedChildren = new Map<string, FolderTreeNode>();
  for (const [key, child] of node.children) {
    collapsedChildren.set(key, collapseTree(child));
  }
  node.children = collapsedChildren;

  // Promote single-service folders: move the service up into the parent.
  const foldersToRemove: string[] = [];
  for (const [key, child] of node.children) {
    if (child.children.size === 0 && child.services.length === 1) {
      node.services.push(child.services[0]);
      foldersToRemove.push(key);
    }
  }
  for (const key of foldersToRemove) {
    node.children.delete(key);
  }

  // Collapse single-child pass-through folder into its child.
  if (node.children.size === 1 && node.services.length === 0 && node.segment !== "") {
    const onlyChild = [...node.children.values()][0];
    onlyChild.segment = `${node.segment}/${onlyChild.segment}`;
    return onlyChild;
  }

  return node;
}

/** Find a folder node by its relative path. */
function findNode(root: FolderTreeNode, relativePath: string): FolderTreeNode | undefined {
  for (const child of root.children.values()) {
    if (child.relativePath === relativePath) {
      return child;
    }
    const found = findNode(child, relativePath);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Count total services under a folder node (recursively). */
function countServices(node: FolderTreeNode): number {
  let count = node.services.length;
  for (const child of node.children.values()) {
    count += countServices(child);
  }
  return count;
}

function encodeServiceFolderNodeKey(appRootPath: string, folderPath: string): string {
  return JSON.stringify({ appRootPath, folderPath });
}

function parseServiceFolderNodeKey(
  key: string,
): { appRootPath: string; folderPath: string } {
  try {
    const parsed = JSON.parse(key) as {
      appRootPath?: string;
      folderPath?: string;
    };
    return {
      appRootPath: parsed.appRootPath ?? "",
      folderPath: parsed.folderPath ?? "",
    };
  } catch {
    return {
      appRootPath: "",
      folderPath: "",
    };
  }
}

function encodeSecretNodeKey(appRootPath: string, secretKey: string): string {
  return JSON.stringify({ appRootPath, secretKey });
}

function parseSecretNodeKey(
  key: string,
): { appRootPath: string; secretKey: string } {
  try {
    const parsed = JSON.parse(key) as {
      appRootPath?: string;
      secretKey?: string;
    };
    return {
      appRootPath: parsed.appRootPath ?? "",
      secretKey: parsed.secretKey ?? "",
    };
  } catch {
    return {
      appRootPath: "",
      secretKey: "",
    };
  }
}

function endpointIcon(endpoint: EndpointInfo): vscode.ThemeIcon {
  if (endpoint.access === "public") {
    return new vscode.ThemeIcon("globe", new vscode.ThemeColor("testing.iconPassed"));
  }
  if (endpoint.access === "auth") {
    return new vscode.ThemeIcon("shield", new vscode.ThemeColor("charts.yellow"));
  }
  return new vscode.ThemeIcon("lock", new vscode.ThemeColor("disabledForeground"));
}

function buildEnvSummary(secret: SecretEntry): string {
  const parts: string[] = [];
  if (secret.environments.production) { parts.push("Prod"); }
  if (secret.environments.development) { parts.push("Dev"); }
  if (secret.environments.local) { parts.push("Local"); }
  if (secret.environments.preview) { parts.push("Preview"); }
  return parts.length > 0 ? parts.join(", ") : "no environments";
}

/**
 * Return the path to the Encore daemon Unix socket.
 *
 * Mirrors the Go logic in encore/cli/cmd/encore/cmdutil/daemon.go
 * which uses os.UserCacheDir() + "encore/encored.sock":
 *   macOS  → ~/Library/Caches/encore/encored.sock
 *   Linux  → $XDG_CACHE_HOME/encore/encored.sock  (or ~/.cache/encore/encored.sock)
 */
function encoreDaemonSocketPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "encore", "encored.sock");
  }

  const xdgCache = process.env.XDG_CACHE_HOME;
  const cacheDir = xdgCache && xdgCache.length > 0
    ? xdgCache
    : path.join(os.homedir(), ".cache");
  return path.join(cacheDir, "encore", "encored.sock");
}
