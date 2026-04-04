import * as vscode from "vscode";
import * as fs from "fs";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { shouldSkipGoWorkspaceFile } from "../utils/workspaceScan";

export interface SubscriptionInfo {
  /** Subscription name string (e.g. "conversations-started"). */
  name: string;
  /** Go variable name of the topic the subscription belongs to. */
  topicVar: string;
  /** Absolute path to the Go file containing the subscription declaration. */
  filePath: string;
  /** Zero-based line number of the subscription declaration. */
  line: number;
}

export interface TopicInfo {
  /** The string identifier passed to pubsub.NewTopic (e.g. "company-created"). */
  topicName: string;
  /** Go variable name holding the topic (e.g. "CompanyCreatedTopic"). */
  varName: string;
  /** Absolute path to the Go file containing the topic declaration. */
  filePath: string;
  /** Zero-based line number of the topic declaration. */
  line: number;
  /** Delivery guarantee: "AtLeastOnce" or "ExactlyOnce". */
  deliveryGuarantee: string;
  /** Subscriptions belonging to the topic. */
  subscriptions: SubscriptionInfo[];
}

// Matches: var <VarName> = pubsub.NewTopic[<Type>]("<topic-name>"
// Also matches inside var (...) blocks where "var" is absent.
const TOPIC_RE =
  /^(?:var\s+)?(\w+)\s*=\s*pubsub\.NewTopic\s*\[[^\]]*\]\s*\(\s*"([^"]+)"/;

// Matches: var _ = pubsub.NewSubscription(<topicRef>, "<sub-name>"
// Also matches: var _ = pubsub.NewSubscription(\n  <topicRef>, "<sub-name>"
// The topic reference can be qualified: "conversations.EventsAppliedTopic".
const SUBSCRIPTION_RE =
  /pubsub\.NewSubscription\(\s*([\w.]+)\s*,\s*"([^"]+)"/;

// Matches: DeliveryGuarantee: pubsub.<Guarantee>
const DELIVERY_RE =
  /DeliveryGuarantee:\s*pubsub\.(\w+)/;

/**
 * In-memory store for discovered Encore Pub/Sub topics and subscriptions.
 *
 * Discovery is file-based — scans Go files for pubsub.NewTopic and
 * pubsub.NewSubscription declarations. Uses a per-file cache so only
 * changed files are re-scanned via the shared GoFileWatcher.
 */
export class PubSubStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private topics = new Map<string, TopicInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed topic declarations. */
  private fileTopicCache = new Map<string, TopicInfo[]>();
  /** Per-file cache: filePath → parsed subscription declarations. */
  private fileSubscriptionCache = new Map<string, SubscriptionInfo[]>();

  getTopics(): readonly TopicInfo[] {
    return [...this.topics.values()].sort((a, b) =>
      a.topicName.localeCompare(b.topicName),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Scan a batch of Go file URIs (used for initial scan and refresh).
   */
  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildTopics();
    this.loaded = true;
    this.onDidChangeEmitter.fire();
  }

  /** Handle batched file change events from the shared GoFileWatcher. */
  async handleFileChanges(events: GoFileChangeEvent[]): Promise<void> {
    let changed = false;

    for (const event of events) {
      const filePath = event.uri.fsPath;

      if (shouldSkipGoWorkspaceFile(filePath)) {
        continue;
      }

      if (event.kind === "delete") {
        const hadTopics = this.fileTopicCache.delete(filePath);
        const hadSubscriptions = this.fileSubscriptionCache.delete(filePath);
        if (hadTopics || hadSubscriptions) {
          changed = true;
        }
        continue;
      }

      this.fileTopicCache.delete(filePath);
      this.fileSubscriptionCache.delete(filePath);
      await this.scanFile(filePath);
      changed = true;
    }

    if (changed) {
      this.rebuildTopics();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileTopicCache.clear();
    this.fileSubscriptionCache.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  private async scanFile(filePath: string): Promise<void> {
    if (shouldSkipGoWorkspaceFile(filePath)) {
      return;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n");
    const fileTopics: TopicInfo[] = [];
    const fileSubscriptions: SubscriptionInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      const topicMatch = trimmed.match(TOPIC_RE);
      if (topicMatch) {
        // Look ahead for DeliveryGuarantee in the next few lines.
        let deliveryGuarantee = "";
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const deliveryMatch = lines[j].match(DELIVERY_RE);
          if (deliveryMatch) {
            deliveryGuarantee = deliveryMatch[1];
            break;
          }
        }

        fileTopics.push({
          varName: topicMatch[1],
          topicName: topicMatch[2],
          filePath,
          line: i,
          deliveryGuarantee,
          subscriptions: [],
        });
        continue;
      }

      const subMatch = trimmed.match(SUBSCRIPTION_RE);
      if (subMatch) {
        fileSubscriptions.push({
          topicVar: subMatch[1],
          name: subMatch[2],
          filePath,
          line: i,
        });
        continue;
      }

      // Subscription declarations can span multiple lines:
      //   var _ = pubsub.NewSubscription(
      //     EventsAppliedTopic,
      //     "subscription-name",
      // Check if the current line has pubsub.NewSubscription( without the rest.
      if (trimmed.includes("pubsub.NewSubscription(") && !subMatch) {
        // Look ahead up to 3 lines for the topic ref and subscription name.
        const lookahead = lines.slice(i, Math.min(i + 4, lines.length)).join(" ");
        const multiLineMatch = lookahead.match(SUBSCRIPTION_RE);
        if (multiLineMatch) {
          fileSubscriptions.push({
            topicVar: multiLineMatch[1],
            name: multiLineMatch[2],
            filePath,
            line: i,
          });
        }
      }
    }

    this.fileTopicCache.set(filePath, fileTopics);
    this.fileSubscriptionCache.set(filePath, fileSubscriptions);
  }

  /**
   * Rebuild the topics map by linking subscriptions to their topic
   * via the Go variable name reference.
   *
   * Subscriptions can reference a topic by bare name ("EventsAppliedTopic")
   * or qualified name ("conversations.EventsAppliedTopic"). Both forms are
   * matched against the topic variable name.
   */
  private rebuildTopics(): void {
    const topicsByVar = new Map<string, TopicInfo>();

    for (const fileTopics of this.fileTopicCache.values()) {
      for (const topic of fileTopics) {
        topicsByVar.set(topic.varName, {
          ...topic,
          subscriptions: [],
        });
      }
    }

    // Assign subscriptions to their topics.
    for (const fileSubscriptions of this.fileSubscriptionCache.values()) {
      for (const sub of fileSubscriptions) {
        const bareVar = sub.topicVar.includes(".")
          ? sub.topicVar.substring(sub.topicVar.lastIndexOf(".") + 1)
          : sub.topicVar;
        const topic = topicsByVar.get(bareVar);
        if (topic) {
          topic.subscriptions.push({
            name: sub.name,
            topicVar: sub.topicVar,
            filePath: sub.filePath,
            line: sub.line,
          });
        }
      }
    }

    // Sort subscriptions within each topic.
    for (const topic of topicsByVar.values()) {
      topic.subscriptions.sort((a, b) => a.name.localeCompare(b.name));
    }

    this.topics = new Map(
      [...topicsByVar.entries()].map(([, topic]) => [topic.topicName, topic]),
    );
  }
}
