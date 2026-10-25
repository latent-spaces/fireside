// Shared shapes at the disk, component, and agent boundaries.
export interface Panel {
  id: string;
  kind: string;
  title?: string;
  source?: string;
  data?: string | object;
  [key: string]: unknown;
}
export interface Icon {
  id: string;
  kind: 'exec' | 'window' | 'prompt' | 'url';
  panel?: string;
  restore?: Panel;
  cmd?: string[];
  label?: string;
  [key: string]: unknown;
}
export interface DeskState {
  panels: Panel[];
  icons: Icon[];
  theme: { skin?: string; vars?: Record<string, string> };
  status: { text: string; tone: string };
  lit?: string;
  [key: string]: unknown;
}
export interface ServerDescriptor {
  url: string;
  port: number;
  pid: number;
  dir: string;
  token: string;
}
export interface SkinAsset { id: string; url?: string; file?: string; referer?: string }
export interface Skin {
  id: string;
  folder: string | null;
  assets?: SkinAsset[];
  [key: string]: unknown;
}
export interface Activity { id?: string; at?: number; type: string; label: string; [key: string]: unknown }
export interface Picker { current: string; options: { value: string; name: string }[] }
export interface SavedSession { id: string; agent: string; title?: string; at?: number }
export interface PreferredSession { agent: string; sessionId: string }
export interface ChatStore {
  sessions: SavedSession[];
  preferred(id?: string): PreferredSession | null;
  setPreferred(id: string, value: PreferredSession | null): void;
  save(): void;
  remember?(id: string, value: unknown): void;
}
export interface ChatOptions {
  root: string;
  id?: string;
  store: ChatStore;
  onChange?: () => void;
  onActivity?: (entry: Activity, row?: Activity) => void;
  spawnAgent?: typeof import('node:child_process').spawn;
  pending?: unknown[];
  includeContext?: boolean;
}
export interface ChatTab {
  id: string;
  acp: import('./acp.mjs').AcpChat;
  unread: boolean;
  operation: number;
  seen: number;
  closing?: boolean;
}
export interface GitInfo {
  repo: boolean;
  branch?: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  fresh?: boolean;
  staged?: { path: string; code: string; label: string }[];
  unstaged?: { path: string; code: string; label: string }[];
  untracked?: { path: string }[];
  commits?: { hash: string; subject: string; when: string }[];
}
