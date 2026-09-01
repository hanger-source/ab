import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Tab } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";

/** Owns every tab created during one isolated benchmark task. */
export class BenchmarkTaskTabs {
  readonly #browser: Browser;
  readonly #owned = new Map<string, Tab>();
  #recorder: ABHarRecorder | null = null;
  #following = false;
  #followTask: Promise<void> | null = null;
  #synchronizing: Promise<void> | null = null;
  #followError: unknown = null;

  private constructor(browser: Browser) {
    this.#browser = browser;
  }

  static async create(browser: Browser): Promise<BenchmarkTaskTabs> {
    return new BenchmarkTaskTabs(browser);
  }

  async open(count: number): Promise<Tab[]> {
    const tabs: Tab[] = [];
    for (let index = 0; index < count; index += 1) {
      const tab = await this.#browser.tabs.open();
      this.#owned.set(tab.id, tab);
      tabs.push(tab);
    }
    return tabs;
  }

  followNetwork(recorder: ABHarRecorder): void {
    if (this.#following) throw new Error("benchmark task tab following is already active");
    this.#recorder = recorder;
    this.#following = true;
    this.#followTask = this.#follow();
  }

  async current(): Promise<Tab[]> {
    await this.synchronize();
    const live = await this.#browser.tabs.list();
    const byId = new Map(live.map((tab) => [tab.id, tab]));
    return [...this.#owned.keys()]
      .map((id) => byId.get(id))
      .filter((tab): tab is Tab => tab !== undefined);
  }

  async synchronize(): Promise<void> {
    if (this.#followError) throw this.#followError;
    if (this.#synchronizing) return this.#synchronizing;
    const synchronizing = this.#synchronize();
    this.#synchronizing = synchronizing;
    try {
      await synchronizing;
    } finally {
      if (this.#synchronizing === synchronizing) this.#synchronizing = null;
    }
  }

  async stopFollowing(): Promise<void> {
    this.#following = false;
    await this.#followTask;
    this.#followTask = null;
    if (this.#followError) throw this.#followError;
    await this.synchronize();
  }

  async close(): Promise<void> {
    const live = await this.#browser.tabs.list().catch(() => []);
    const tabs = live.filter((tab) => this.#owned.has(tab.id));
    await Promise.all(tabs.map((tab) => tab.close().catch(() => undefined)));
    this.#owned.clear();
  }

  async #synchronize(): Promise<void> {
    const current = await this.#browser.tabs.list();
    const discovered: Tab[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const tab of current) {
        if (this.#owned.has(tab.id) || !tab.openerId || !this.#owned.has(tab.openerId)) continue;
        this.#owned.set(tab.id, tab);
        discovered.push(tab);
        changed = true;
      }
    }
    if (discovered.length > 0 && this.#recorder) {
      for (const tab of discovered) {
        try {
          await this.#recorder.addTabs(tab, { late: tab.url !== "about:blank" });
        } catch (error) {
          this.#recorder.markAttachmentFailure(tab.id, error);
        }
      }
    }
  }

  async #follow(): Promise<void> {
    try {
      while (this.#following) {
        await this.synchronize();
        await delay(100);
      }
    } catch (error) {
      this.#followError = error;
      this.#following = false;
    }
  }
}
