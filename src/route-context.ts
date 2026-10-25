import type { ServerResponse } from 'node:http';
import type { Activity, DeskState, Panel } from './contracts.ts';
import type { ChatTabs } from './chats.mjs';
import type { createLayout } from './layout.mjs';
import type { createSubscriptions } from './subscriptions.mjs';
import type { createSkinAssets } from './skin-assets.ts';
import type { createAppAssets } from './app-assets.ts';
import type { list } from './desks.mjs';
import type { listWindows } from './catalog.ts';

export interface RouteContext extends ReturnType<typeof createSkinAssets> {
  ROOT: string;
  TOKEN: string;
  codeId: string;
  url(): string;
  snapshot(): unknown;
  clients: Set<ServerResponse>;
  layout: ReturnType<typeof createLayout>;
  tabs: ChatTabs;
  subscriptions: ReturnType<typeof createSubscriptions>;
  appAssets: Awaited<ReturnType<typeof createAppAssets>>;
  record(entry: Activity): unknown;
  deskList(): ReturnType<typeof list>;
  busyChat(): unknown;
  pushAcp(): void;
  pushState(): void;
  agentStatus(): void;
  follows(panel: Panel, feed: string): boolean;
  getState(): DeskState;
  refreshState(): DeskState;
  appendBuffer(id: string, lines: string[]): void;
  windowList(): ReturnType<typeof listWindows>;
  revision(): number;
  skinRevision(): string | number;
}
