import * as vscode from "vscode";
import * as fs from "fs";

import { GoFileChangeEvent } from "../utils/goFileWatcher";
import { shouldSkipGoWorkspaceFile } from "../utils/workspaceScan";

export interface CronJobInfo {
  /** The string identifier passed to cron.NewJob (e.g. "welcome-email"). */
  jobId: string;
  /** Human-readable title from the JobConfig (e.g. "Send welcome emails"). */
  title: string;
  /** Schedule expression: either an "Every" duration or a cron expression. */
  schedule: string;
  /** Absolute path to the Go file containing the cron job declaration. */
  filePath: string;
  /** Zero-based line number of the cron job declaration. */
  line: number;
}

// Matches: cron.NewJob("<job-id>"
// Can appear as var _ = cron.NewJob(...) or inside var (...) blocks.
const CRON_JOB_RE =
  /cron\.NewJob\(\s*"([^"]+)"/;

// Matches: Title: "Some Title"
const TITLE_RE =
  /Title:\s*"([^"]+)"/;

// Matches: Every: 2 * cron.Hour  or  Every: cron.Minute  etc.
const EVERY_RE =
  /Every:\s*([\w.*\s]+)/;

// Matches: Schedule: "0 4 15 * *"
const SCHEDULE_RE =
  /Schedule:\s*"([^"]+)"/;

/**
 * In-memory store for discovered Encore cron jobs.
 *
 * Discovery is file-based — scans Go files for cron.NewJob
 * declarations. Uses a per-file cache so only changed files
 * are re-scanned via the shared GoFileWatcher.
 */
export class CronStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private jobs = new Map<string, CronJobInfo>();
  private loaded = false;

  /** Per-file cache: filePath → parsed cron job declarations. */
  private fileCache = new Map<string, CronJobInfo[]>();

  getJobs(): readonly CronJobInfo[] {
    return [...this.jobs.values()].sort((a, b) =>
      a.jobId.localeCompare(b.jobId),
    );
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async scanFiles(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.scanFile(uri.fsPath);
    }
    this.rebuildJobs();
    this.loaded = true;
    this.onDidChangeEmitter.fire();
  }

  async handleFileChanges(events: GoFileChangeEvent[]): Promise<void> {
    let changed = false;

    for (const event of events) {
      const filePath = event.uri.fsPath;

      if (shouldSkipGoWorkspaceFile(filePath)) {
        continue;
      }

      if (event.kind === "delete") {
        if (this.fileCache.delete(filePath)) {
          changed = true;
        }
        continue;
      }

      this.fileCache.delete(filePath);
      await this.scanFile(filePath);
      changed = true;
    }

    if (changed) {
      this.rebuildJobs();
      this.onDidChangeEmitter.fire();
    }
  }

  refresh(): void {
    this.fileCache.clear();
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
    const entries: CronJobInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      const cronMatch = trimmed.match(CRON_JOB_RE);
      if (cronMatch) {
        const jobId = cronMatch[1];

        // Look ahead for Title, Every, and Schedule in the next few lines.
        let title = "";
        let schedule = "";
        for (let j = i; j < Math.min(i + 8, lines.length); j++) {
          const titleMatch = lines[j].match(TITLE_RE);
          if (titleMatch) {
            title = titleMatch[1];
          }

          const scheduleMatch = lines[j].match(SCHEDULE_RE);
          if (scheduleMatch) {
            schedule = scheduleMatch[1];
          }

          const everyMatch = lines[j].match(EVERY_RE);
          if (everyMatch && !schedule) {
            schedule = formatEverySchedule(everyMatch[1].trim());
          }
        }

        entries.push({
          jobId,
          title,
          schedule,
          filePath,
          line: i,
        });
      }
    }

    this.fileCache.set(filePath, entries);
  }

  private rebuildJobs(): void {
    const jobMap = new Map<string, CronJobInfo>();

    for (const entries of this.fileCache.values()) {
      for (const entry of entries) {
        jobMap.set(entry.jobId, entry);
      }
    }

    this.jobs = jobMap;
  }
}

/**
 * Convert a raw "Every" value like "2 * cron.Hour" into a readable
 * string like "every 2h". Handles forms:
 *   cron.Minute → every 1m
 *   30 * cron.Minute → every 30m
 *   2 * cron.Hour → every 2h
 */
function formatEverySchedule(raw: string): string {
  // Remove trailing commas or whitespace.
  const cleaned = raw.replace(/,\s*$/, "").trim();

  // Pattern: <N> * cron.<Unit>
  const multiplied = cleaned.match(/^(\d+)\s*\*\s*cron\.(\w+)/);
  if (multiplied) {
    const count = multiplied[1];
    const unit = unitSuffix(multiplied[2]);
    return `every ${count}${unit}`;
  }

  // Pattern: cron.<Unit> (implicitly 1)
  const single = cleaned.match(/^cron\.(\w+)/);
  if (single) {
    const unit = unitSuffix(single[1]);
    return `every 1${unit}`;
  }

  return cleaned;
}

function unitSuffix(unit: string): string {
  switch (unit) {
    case "Minute": return "m";
    case "Hour": return "h";
    default: return ` ${unit.toLowerCase()}`;
  }
}
