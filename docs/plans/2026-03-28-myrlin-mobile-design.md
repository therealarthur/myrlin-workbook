# Myrlin Mobile - Design Document

> **Status:** Approved design, pre-implementation
> **Date:** 2026-03-28
> **Target:** iOS first (React Native / Expo), Android within 2 weeks of iOS launch
> **Source:** `mobile/` directory in myrlin-workbook monorepo
> **Parity:** Full feature parity with web GUI (100+ features)

---

## 1. Executive Summary

Myrlin Mobile is a React Native (Expo) app that provides full control over Myrlin's Workbook servers from iOS and Android. It connects to self-hosted Myrlin servers via QR code pairing or manual URL entry. Every feature available on the web GUI is accessible on mobile with native iOS/Android interactions (share sheet, haptics, push notifications, biometric auth, camera).

**Free tier:** Direct connection to your own server. No account needed.
**Paid tier (future):** myrlin.io relay service, managed hosting, multi-user sync.

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | Expo SDK 52+ / React Native | Cross-platform mobile |
| Navigation | expo-router (file-based) | Tab + stack navigation |
| State (local) | Zustand | UI state, preferences, theme |
| State (server) | TanStack Query (React Query) | Server data, caching, SSE sync |
| Terminal | xterm.js in WebView (hybrid) | Terminal rendering engine |
| Animations | react-native-reanimated 3 | 60fps native animations |
| Lists | @shopify/flash-list | Performant scrolling lists |
| Gestures | react-native-gesture-handler | Drag-drop, swipe, long-press |
| Storage | expo-secure-store | Auth tokens, server configs |
| Storage | @react-native-async-storage | Cached state, preferences |
| Push | expo-notifications | Push notification handling |
| Camera | expo-camera + expo-barcode-scanner | QR code scanning |
| Haptics | expo-haptics | Tactile feedback |
| Biometrics | expo-local-authentication | Face ID / fingerprint |
| Speech | expo-speech (TTS) + @react-native-voice | Voice input |
| Image | expo-image-picker | Photo/camera upload to sessions |
| Share | react-native-share | Native share sheet |
| Charts | react-native-svg + victory-native | Cost dashboard charts |
| Theme | React Context + Zustand | 13 Catppuccin themes |

---

## 3. Architecture

### 3.1 High-Level Architecture

```
┌───────────────────────────────────────────────┐
│              Myrlin Mobile App                │
├──────────────┬────────────────────────────────┤
│  UI Layer    │  Screens, Components, Theme     │
│  (React)     │  Navigation (expo-router)       │
├──────────────┼────────────────────────────────┤
│  State Layer │  Zustand (local UI state)       │
│              │  TanStack Query (server data)   │
│              │  SSE Client (real-time sync)    │
├──────────────┼────────────────────────────────┤
│  API Layer   │  Typed HTTP client              │
│              │  WebSocket client (terminal)    │
│              │  Push notification handler      │
├──────────────┼────────────────────────────────┤
│  Platform    │  SecureStore, AsyncStorage      │
│  Layer       │  Camera, Haptics, Biometrics    │
│              │  Share, Image Picker, Speech    │
└──────────────┴────────────────────────────────┘
         │                    │
         │ HTTPS/WSS          │ SSE
         ▼                    ▼
┌───────────────────────────────────────────────┐
│          Myrlin Server (Express)              │
│  Existing API + new mobile endpoints          │
│  /api/auth/pair (QR pairing)                  │
│  /api/push/register (push tokens)             │
└───────────────────────────────────────────────┘
```

### 3.2 Multi-Server Architecture

The app supports connecting to multiple Myrlin servers (home PC, work machine, etc.).

```typescript
// Stored in expo-secure-store (encrypted)
interface ServerConnection {
  id: string;                // UUID
  name: string;              // User-given name ("Home PC", "Work")
  url: string;               // "https://myrlin.example.com" or "http://192.168.1.50:3456"
  token: string;             // Bearer auth token
  pairedAt: string;          // ISO timestamp
  lastConnected: string;     // ISO timestamp
  isActive: boolean;         // Currently selected server
  pushRegistered: boolean;   // Whether push token sent to this server
  tunnelType: 'lan' | 'cloudflare' | 'tailscale' | 'relay';
}

// App state
interface AppState {
  servers: ServerConnection[];
  activeServerId: string | null;
  onboarding: boolean;       // True until first server paired
}
```

### 3.3 Terminal Architecture (Hybrid Model)

The terminal uses a **hybrid** approach where React Native owns all user interaction and a WebView acts as a rendering engine only.

```
┌─────────────────────────────────────────┐
│  React Native (interaction controller)  │
│  ┌───────────────────────────────────┐  │
│  │ Native Header                     │  │
│  │ Session name, status dot, back    │  │
│  ├───────────────────────────────────┤  │
│  │ WebView (xterm.js canvas)         │  │
│  │ - Receives output via postMessage │  │
│  │ - Sends nothing back directly     │  │
│  │ - Theme injected as CSS vars      │  │
│  │ - Text query API for selection    │  │
│  ├───────────────────────────────────┤  │
│  │ Native Toolbar                    │  │
│  │ [Copy] [Paste] [Share] [Mic]     │  │
│  │ [Camera] [Reader] [Expand]       │  │
│  ├───────────────────────────────────┤  │
│  │ Native TextInput                  │  │
│  │ iOS keyboard, autocorrect,        │  │
│  │ dictation, paste, suggestions     │  │
│  │ [Send button]                     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Bridge Protocol (RN <-> WebView):**

```typescript
// RN -> WebView messages
type ToWebView =
  | { type: 'write'; data: string }           // Terminal output from WS
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'setTheme'; theme: TerminalTheme }
  | { type: 'clear' }
  | { type: 'getSelectedText' }              // Request selected text
  | { type: 'getVisibleText' }              // Request visible content
  | { type: 'getScrollback' }               // Request full scrollback
  | { type: 'selectAll' }
  | { type: 'scrollToBottom' }
  | { type: 'focus' }
  | { type: 'blur' };

// WebView -> RN messages
type FromWebView =
  | { type: 'ready' }                         // xterm initialized
  | { type: 'selectedText'; text: string }     // Response to getSelectedText
  | { type: 'visibleText'; text: string }
  | { type: 'scrollback'; text: string }
  | { type: 'activity'; kind: string; detail: string }  // Activity detection
  | { type: 'bell' }                          // Terminal bell
  | { type: 'titleChange'; title: string }
  | { type: 'dimensions'; cols: number; rows: number };
```

**Terminal Renderer Interface (pluggable):**

```typescript
interface TerminalRenderer {
  connect(sessionId: string, wsUrl: string): void;
  disconnect(): void;
  write(data: string): void;
  getSelectedText(): Promise<string>;
  getVisibleText(): Promise<string>;
  getScrollback(): Promise<string>;
  setTheme(theme: TerminalTheme): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  blur(): void;
  onActivity?: (kind: string, detail: string) => void;
  onBell?: () => void;
  onExit?: (code: number) => void;
}
```

Today: `WebViewTerminal implements TerminalRenderer`
Future: `NativeTerminal implements TerminalRenderer` (if we ever build one)

---

## 4. Navigation Structure

### 4.1 Screen Map

```
(not authenticated)
├── OnboardingScreen          - First launch, no servers paired
├── ScanQRScreen              - Camera for QR code scanning
├── ManualConnectScreen       - Type URL + password
└── LoginScreen               - Password entry for known server

(authenticated)
BottomTabs
├── Sessions (Tab 1, default)
│   ├── SessionsListScreen    - All sessions, workspace filter, search bar
│   ├── SessionDetailScreen   - Metadata, cost, logs, subagents, controls
│   └── TerminalScreen        - Full-screen terminal (push, no tab bar)
├── Tasks (Tab 2)
│   ├── KanbanBoardScreen     - Draggable kanban columns
│   └── TaskDetailScreen      - Task metadata, diff, PR, timeline
├── Costs (Tab 3)
│   └── CostDashboardScreen   - Period selector, charts, breakdowns
├── Docs (Tab 4)
│   ├── DocsListScreen        - Notes, goals, tasks, roadmap, rules
│   ├── NoteEditorScreen      - Markdown editor
│   └── FeatureBoardScreen    - Feature kanban
└── More (Tab 5)
    ├── WorkspacesScreen      - Manage workspaces, groups, colors
    ├── ResourcesScreen       - CPU/memory per session
    ├── RecentScreen          - Recently active sessions
    ├── SearchScreen          - Global + AI search
    ├── TemplatesScreen       - View/delete templates
    ├── ConflictCenterScreen  - File conflict resolution
    ├── SessionManagerScreen  - Bulk session controls
    ├── ServerSettingsScreen  - Connected servers, add/remove
    └── SettingsScreen        - All preferences, theme picker
```

### 4.2 Modal Screens (present over any tab)

```
Modals (presented as sheets)
├── NewSessionModal           - Create session form + template chips
├── NewWorkspaceModal         - Create workspace form
├── NewTaskModal              - Create worktree task
├── RenameModal               - Rename session/workspace
├── DeleteConfirmModal        - Destructive action confirmation
├── ActionSheetModal          - Context menu replacement (iOS action sheet)
├── QuickSwitcherModal        - Command palette (swipe down or search icon)
├── SpinoffModal              - Extract tasks from session
├── ImageUploadModal          - Photo picker + message
├── ThemePickerModal          - Theme selection with live preview
├── ServerPairingModal        - QR + manual URL options
└── UpdateModal               - App update notification
```

### 4.3 Tab Bar Configuration (data-driven, reorderable in future)

```typescript
interface TabConfig {
  id: string;
  label: string;
  icon: string;              // SF Symbol name (iOS) / Material Icon (Android)
  screen: string;            // expo-router path
  badge?: () => number;      // Dynamic badge count
  accentColor?: string;      // Tab-specific accent (from web: mauve, green, peach)
}

const defaultTabs: TabConfig[] = [
  { id: 'sessions', label: 'Sessions', icon: 'terminal', screen: '/(tabs)/sessions', badge: () => runningCount, accentColor: 'blue' },
  { id: 'tasks',    label: 'Tasks',    icon: 'checklist', screen: '/(tabs)/tasks', badge: () => reviewCount, accentColor: 'mauve' },
  { id: 'costs',    label: 'Costs',    icon: 'chart.bar', screen: '/(tabs)/costs', accentColor: 'green' },
  { id: 'docs',     label: 'Docs',     icon: 'doc.text',  screen: '/(tabs)/docs', accentColor: 'peach' },
  { id: 'more',     label: 'More',     icon: 'ellipsis',  screen: '/(tabs)/more' },
];
```

---

## 5. Shared Contracts (Types)

These types are used by every agent building every screen. They match the server API exactly.

### 5.1 API Response Types

```typescript
// === WORKSPACES ===

interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string;
  sessions: string[];          // Session IDs
  createdAt: string;
  lastActive: string;
  autoSummary: boolean;
}

interface WorkspaceGroup {
  id: string;
  name: string;
  color: string;
  workspaceIds: string[];
  order: number;
}

// === SESSIONS ===

interface Session {
  id: string;
  name: string;
  workspaceId: string;
  workingDir: string;
  topic: string;
  command: string;
  resumeSessionId: string | null;
  status: 'stopped' | 'running' | 'error' | 'idle';
  pid: number | null;
  tags: string[];
  initialPrompt: string | null;
  flags: string[];
  createdAt: string;
  lastActive: string;
  logs: SessionLog[];
}

interface SessionLog {
  time: string;
  message: string;
}

// === WORKTREE TASKS ===

type TaskStatus = 'backlog' | 'running' | 'review' | 'completed' | 'merged' | 'rejected';

interface WorktreeTask {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  featureId: string | null;
  branch: string;
  worktreePath: string;
  repoDir: string;
  baseBranch: string;
  description: string;
  model: string | null;
  tags: string[];
  status: TaskStatus;
  pr: PullRequest | null;
  history: TaskTransition[];
  blockedBy: string[];
  createdAt: string;
  completedAt: string | null;
}

interface TaskTransition {
  status: TaskStatus;
  at: string;
}

interface PullRequest {
  number: number;
  state: string;
  url: string;
  reviewDecision?: string;
}

// === COST ===

interface SessionCost {
  totalCost: number;
  breakdown: {
    input: { tokens: number; cost: number };
    output: { tokens: number; cost: number };
    cacheWrite: { tokens: number; cost: number };
    cacheRead: { tokens: number; cost: number };
  };
  byModel: Record<string, { input: number; output: number; cost: number }>;
  messageCount: number;
}

interface CostDashboard {
  total: number;
  byWorkspace: Record<string, { name: string; cost: number; sessions: number }>;
  byModel: Record<string, { cost: number; tokens: number }>;
  daily: Record<string, number>;       // ISO date -> cost
  topSessions: { id: string; name: string; cost: number }[];
}

// === DOCS ===

interface WorkspaceDocs {
  raw: string;
  notes: DocNote[];
  goals: DocItem[];
  tasks: DocItem[];
  roadmap: RoadmapItem[];
  rules: DocRule[];
}

interface DocNote {
  timestamp: string;
  text: string;
}

interface DocItem {
  text: string;
  done: boolean;
}

interface RoadmapItem {
  text: string;
  status: 'planned' | 'active' | 'done';
}

interface DocRule {
  text: string;
}

// === FEATURES ===

interface Feature {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: 'planned' | 'in-progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  sessionIds: string[];
  createdAt: string;
}

// === TEMPLATES ===

interface SessionTemplate {
  id: string;
  name: string;
  command: string;
  workingDir: string;
  bypassPermissions: boolean;
  verbose: boolean;
  model: string;
  agentTeams: boolean;
  createdAt: string;
}

// === RESOURCES ===

interface ResourceMetrics {
  cpuUsage: number;
  memory: { total: number; used: number; free: number };
  processes: ProcessInfo[];
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  sessionId?: string;
}

// === CONFLICTS ===

interface FileConflict {
  file: string;
  sessions: { id: string; name: string }[];
  detectedAt: string;
}

// === AUTH ===

interface LoginResponse {
  success: boolean;
  token?: string;
  error?: string;
}

interface PairingQRPayload {
  url: string;
  pairingToken: string;
  serverName: string;
  version: string;
}
```

### 5.2 API Client Interface

```typescript
interface MyrlinAPI {
  // Auth
  login(password: string): Promise<LoginResponse>;
  tokenLogin(token: string): Promise<LoginResponse>;
  pair(pairingToken: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  checkAuth(): Promise<{ authenticated: boolean }>;

  // Workspaces
  getWorkspaces(): Promise<{ workspaces: Workspace[]; workspaceOrder: string[] }>;
  getWorkspace(id: string): Promise<{ workspace: Workspace & { sessionObjects: Session[] } }>;
  createWorkspace(data: { name: string; description?: string; color?: string }): Promise<{ workspace: Workspace }>;
  updateWorkspace(id: string, data: Partial<Workspace>): Promise<{ workspace: Workspace }>;
  deleteWorkspace(id: string): Promise<void>;
  reorderWorkspaces(order: string[]): Promise<void>;

  // Sessions
  getSessions(): Promise<{ sessions: Session[]; recentSessions: Session[] }>;
  createSession(data: CreateSessionInput): Promise<{ session: Session }>;
  updateSession(id: string, data: Partial<Session>): Promise<{ session: Session }>;
  deleteSession(id: string): Promise<void>;
  startSession(id: string): Promise<{ success: boolean; pid: number }>;
  stopSession(id: string): Promise<void>;
  restartSession(id: string): Promise<{ success: boolean; pid: number }>;

  // Session AI features
  autoTitle(id: string): Promise<{ title: string }>;
  summarize(id: string): Promise<{ summary: string }>;
  extractTasks(id: string): Promise<{ tasks: ExtractedTask[] }>;
  refocus(id: string, data: { newTopic: string; instructions?: string }): Promise<void>;

  // Cost
  getSessionCost(id: string): Promise<SessionCost>;
  getCostBatch(sessionIds: string[]): Promise<{ costs: Record<string, SessionCost>; total: number }>;
  getCostDashboard(): Promise<CostDashboard>;
  getWorkspaceCost(id: string): Promise<{ total: number; sessions: any[] }>;

  // Tasks
  getWorktreeTasks(): Promise<{ tasks: WorktreeTask[] }>;
  createWorktreeTask(data: CreateTaskInput): Promise<{ task: WorktreeTask }>;
  updateWorktreeTask(id: string, data: Partial<WorktreeTask>): Promise<{ task: WorktreeTask }>;
  deleteWorktreeTask(id: string): Promise<void>;
  mergeTask(id: string, options?: { autoPush?: boolean }): Promise<void>;
  rejectTask(id: string): Promise<void>;
  createPR(id: string, data: { title: string; body?: string }): Promise<{ pr: PullRequest }>;
  getTaskChanges(id: string): Promise<{ additions: number; deletions: number; files: any[] }>;

  // Docs
  getWorkspaceDocs(workspaceId: string): Promise<WorkspaceDocs>;
  updateWorkspaceDocs(workspaceId: string, content: string): Promise<WorkspaceDocs>;
  addDocItem(workspaceId: string, section: string, data: any): Promise<void>;
  updateDocItem(workspaceId: string, section: string, index: number, data: any): Promise<void>;
  deleteDocItem(workspaceId: string, section: string, index: number): Promise<void>;

  // Features
  getFeatures(workspaceId: string): Promise<{ features: Feature[] }>;
  createFeature(workspaceId: string, data: Partial<Feature>): Promise<{ feature: Feature }>;
  updateFeature(id: string, data: Partial<Feature>): Promise<{ feature: Feature }>;
  deleteFeature(id: string): Promise<void>;

  // Templates
  getTemplates(): Promise<{ templates: SessionTemplate[] }>;
  createTemplate(data: Partial<SessionTemplate>): Promise<{ template: SessionTemplate }>;
  deleteTemplate(id: string): Promise<void>;

  // Groups
  getGroups(): Promise<{ groups: WorkspaceGroup[] }>;
  createGroup(data: { name: string; color?: string }): Promise<{ group: WorkspaceGroup }>;
  updateGroup(id: string, data: Partial<WorkspaceGroup>): Promise<{ group: WorkspaceGroup }>;
  deleteGroup(id: string): Promise<void>;

  // Resources
  getResources(): Promise<ResourceMetrics>;
  killProcess(pid: number): Promise<void>;

  // Search
  search(query: string): Promise<{ results: any[] }>;
  searchConversations(data: { query: string; workspaceId?: string }): Promise<{ results: any[] }>;

  // Conflicts
  getConflicts(): Promise<{ conflicts: FileConflict[] }>;

  // Push notifications
  registerPush(data: { deviceToken: string; platform: 'ios' | 'android' }): Promise<void>;
  unregisterPush(data: { deviceToken: string }): Promise<void>;

  // Discovery
  discover(): Promise<{ sessions: any[] }>;
  browse(path: string): Promise<{ directories: string[]; files: string[] }>;

  // Git
  getGitStatus(path: string): Promise<{ branch: string; status: string; files: any[] }>;
  getGitBranches(repoDir: string): Promise<{ branches: string[]; current: string }>;

  // Tunnel
  getTunnels(): Promise<{ tunnels: any[] }>;
  createTunnel(port: number): Promise<any>;
  deleteTunnel(id: string): Promise<void>;

  // System
  getHealth(): Promise<{ status: string; uptime: number }>;
  getVersion(): Promise<{ version: string }>;
  getStats(): Promise<any>;
}
```

### 5.3 SSE Event Types

```typescript
type SSEEvent =
  | { type: 'workspace:created'; data: Workspace }
  | { type: 'workspace:updated'; data: Workspace }
  | { type: 'workspace:deleted'; data: { id: string } }
  | { type: 'session:created'; data: Session }
  | { type: 'session:updated'; data: Session }
  | { type: 'session:deleted'; data: { id: string } }
  | { type: 'session:log'; data: { id: string; message: string } }
  | { type: 'docs:updated'; data: { workspaceId: string } }
  | { type: 'worktreeTask:created'; data: { task: WorktreeTask } }
  | { type: 'worktreeTask:updated'; data: { task: WorktreeTask } }
  | { type: 'worktreeTask:deleted'; data: { id: string } }
  | { type: 'feature:created'; data: Feature }
  | { type: 'feature:updated'; data: Feature }
  | { type: 'feature:deleted'; data: { id: string } }
  | { type: 'template:created'; data: SessionTemplate }
  | { type: 'template:deleted'; data: { id: string } }
  | { type: 'group:created'; data: WorkspaceGroup }
  | { type: 'group:updated'; data: WorkspaceGroup }
  | { type: 'group:deleted'; data: { id: string } }
  | { type: 'settings:updated'; data: any };
```

### 5.4 Theme Contract

```typescript
interface MyrlinTheme {
  id: string;
  name: string;
  isDark: boolean;

  colors: {
    // Catppuccin base
    base: string;
    mantle: string;
    crust: string;
    surface0: string;
    surface1: string;
    surface2: string;
    overlay0: string;
    overlay1: string;
    text: string;
    subtext0: string;
    subtext1: string;

    // Accent palette
    mauve: string;
    blue: string;
    green: string;
    yellow: string;
    red: string;
    peach: string;
    teal: string;
    sky: string;
    pink: string;
    lavender: string;
    flamingo: string;
    rosewater: string;
    sapphire: string;

    // Semantic aliases
    accent: string;          // = mauve
    success: string;         // = green
    warning: string;         // = yellow
    error: string;           // = red
    info: string;            // = blue

    // UI semantic
    bgPrimary: string;       // = base
    bgSecondary: string;     // = mantle
    bgTertiary: string;      // = crust
    bgElevated: string;      // = surface0
    borderSubtle: string;    // = surface1 @ 50% opacity
    borderDefault: string;   // = surface1
    textPrimary: string;     // = text
    textSecondary: string;   // = subtext1
    textTertiary: string;    // = subtext0
    textMuted: string;       // = overlay1
  };

  spacing: {
    xs: number;   // 4
    sm: number;   // 8
    md: number;   // 16
    lg: number;   // 24
    xl: number;   // 32
    xxl: number;  // 48
  };

  radius: {
    sm: number;   // 6
    md: number;   // 10
    lg: number;   // 14
    xl: number;   // 18
    full: number; // 9999 (pill)
  };

  typography: {
    fontSans: string;        // 'PlusJakartaSans'
    fontMono: string;        // 'JetBrainsMono'
    sizes: {
      xs: number;   // 10
      sm: number;   // 12
      md: number;   // 14
      lg: number;   // 16
      xl: number;   // 20
      xxl: number;  // 24
    };
    weights: {
      regular: string;  // '400'
      medium: string;   // '500'
      semibold: string; // '600'
      bold: string;     // '700'
    };
  };

  shadows: {
    sm: object;
    md: object;
    lg: object;
  };

  animation: {
    fast: number;     // 150
    normal: number;   // 200
    slow: number;     // 300
    easing: number[]; // [0.16, 1, 0.3, 1] cubic bezier
  };
}

// All 13 themes exported
const themes: Record<string, MyrlinTheme> = {
  mocha, macchiato, frappe, latte,
  nord, dracula, tokyoNight,
  cherry, ocean, amber, mint,
  rosePineDawn, gruvboxLight,
};
```

---

## 6. Component Library (Shared)

Every screen uses these shared components. They match the web app's design language exactly.

### 6.1 Core Components

| Component | Props | Notes |
|-----------|-------|-------|
| `Button` | variant: 'primary' / 'ghost' / 'danger', size: 'sm' / 'md', loading, disabled, icon | Matches web .btn-* |
| `Badge` | variant: 'status' / 'model' / 'cost' / 'port' / 'tag', color | Matches web .session-badge-* |
| `StatusDot` | status: 'running' / 'stopped' / 'error' / 'idle', size, animated | Pulsing green dot |
| `Card` | elevated, bordered, pressable, onLongPress | Surface0 bg, radius-md |
| `Input` | label, placeholder, value, secureEntry, icon, error | Matches web input-group |
| `Toggle` | value, onValueChange, label | Matches web toggle switch |
| `SegmentedControl` | options, selectedIndex, onChange | For view mode switching |
| `ActionSheet` | options (with icons, destructive flag), onSelect | iOS action sheet style |
| `EmptyState` | icon, title, description, action | Consistent empty views |
| `SectionHeader` | title, count, collapsible, action | Matches web section headers |
| `Skeleton` | width, height, radius | Loading placeholder |
| `Toast` | type: 'info' / 'success' / 'warning' / 'error', message | Bottom notification |
| `SearchBar` | value, placeholder, onSearch, debounceMs | Top-of-list search |
| `MetaRow` | label, value, copyable, mono | Matches web meta-grid rows |
| `TokenBar` | input, output, cacheWrite, cacheRead | Stacked token visualization |
| `TabBar` | tabs, activeIndex, onChange, badges | Bottom tab bar |
| `ModalSheet` | title, snapPoints, children | Bottom sheet modal |
| `Chip` | label, icon, onPress, selected | Template chips, filter chips |
| `DraggableList` | data, renderItem, onReorder | Drag-to-reorder |

### 6.2 Domain Components

| Component | Props | Notes |
|-----------|-------|-------|
| `SessionCard` | session, onPress, onLongPress, showWorkspace | Session list item |
| `WorkspaceItem` | workspace, sessions, expanded, onToggle | Accordion in sidebar |
| `KanbanColumn` | title, color, tasks, onDrop | Task board column |
| `KanbanCard` | task, onPress, onLongPress, isDragging | Task card |
| `CostSummaryCard` | label, value, trend, icon | Cost metric card |
| `CostChart` | data, period, type: 'line' / 'bar' | Timeline chart |
| `DocSection` | title, items, onAdd, onEdit, onDelete | Docs list section |
| `FeatureCard` | feature, onPress, onDragEnd | Feature board card |
| `ConflictRow` | conflict, onResolve | Conflict list item |
| `ResourceRow` | process, onKill | Resource monitor row |
| `TerminalView` | sessionId, serverUrl, theme | Hybrid terminal component |
| `ActivityIndicator` | kind, detail | Session activity label |
| `ServerCard` | server, isActive, onSelect, onRemove | Server connection card |
| `QRScanner` | onScan, onError | QR code scanning overlay |

---

## 7. Screen Specifications

### 7.1 Sessions Tab

**SessionsListScreen:**
- Top: SearchBar (replaces Quick Switcher on mobile)
- Below search: Workspace filter chips (horizontal scroll, "All" + each workspace)
- List: SessionCard items grouped by workspace (collapsible)
- Each card: status dot, name, workspace badge, topic (truncated), last active, cost badge
- Long press: ActionSheet (Start, Stop, Restart, Rename, Move, Delete, Save as Template)
- Pull-to-refresh
- FAB (floating action button): New Session
- Running session count in section header

**SessionDetailScreen:**
- Header: session name (editable), status badge, workspace badge
- Sections (scrollable):
  - Controls: Start / Stop / Restart buttons
  - Metadata: MetaRow grid (directory, topic, command, PID, branch, created, last active)
  - Tags: chip row (editable)
  - Cost Summary: total, model breakdown, token bar
  - Subagents: count badge + list (if any)
  - Activity Log: chronological log entries
- Bottom bar: "Open Terminal" button (primary, full-width)

**TerminalScreen:**
- Full screen (no tab bar)
- Native header: back button, session name, status dot, overflow menu
- Terminal WebView (flex: 1)
- Native toolbar: Copy, Paste, Share, Mic, Camera, Reader, Scroll-to-bottom
- Native TextInput bar at bottom with Send button
- Keyboard avoidance (moves input bar above keyboard)
- Activity indicator in header

### 7.2 Tasks Tab

**KanbanBoardScreen:**
- Toggle: Board / List view (SegmentedControl)
- Board: horizontal scroll between columns (Backlog, Planning, Running, Review, Done)
- Each column: colored header, task count, scrollable card list
- Cards: title, branch name, tags, changed files count, PR badge, blocked indicator
- Drag card between columns to change status (react-native-gesture-handler)
- Long press card: ActionSheet (Set Blocker, Assign Model, Tags, Priority, Timeline, PR, Delete)
- FAB: New Task
- List view: vertical sections grouped by status

### 7.3 Costs Tab

**CostDashboardScreen:**
- Period selector: SegmentedControl (Today, 7d, 30d, All)
- Summary cards row: Total, Period, Avg/msg, Cache savings
- Timeline chart (line graph, cost over time)
- By Model: horizontal bar chart
- By Workspace: list with cost bars
- Top Sessions: ranked list with cost badges
- Pull-to-refresh

### 7.4 Docs Tab

**DocsListScreen:**
- Workspace picker at top
- Tab bar: Docs / Board
- Docs tab: Collapsible sections (Notes, Goals, Tasks, Roadmap, Rules, AI Insights)
- Each section: item count, add button, list of items
- Goals/Tasks: checkbox toggle
- Roadmap: status badges (planned/active/done)
- Tap item to edit (push NoteEditorScreen)
- Swipe left to delete

**FeatureBoardScreen:**
- Three columns: Backlog, Active, Done
- Feature cards with priority badge and tag chips
- Drag between columns
- FAB: New Feature

### 7.5 More Tab

**MoreScreen:**
- Grid or list of options with icons
- Each option navigates to its screen
- Notification badges on items that need attention (conflicts, updates)
- Server connection status at top (green dot + server name)

**SettingsScreen:**
- Sections matching web: Terminal, Notifications, Interface, Automation, Advanced, AI, Remote
- Toggle rows, text inputs, sliders
- Theme picker row (opens ThemePickerModal)
- Server management row (opens ServerSettingsScreen)
- About section: version, update check

---

## 8. Server-Side Additions

The existing Myrlin server needs these new endpoints:

### 8.1 QR Pairing

```typescript
// New file: src/web/pairing.js

// Generate pairing code (called from desktop web UI)
// GET /api/auth/pairing-code
// Response: { pairingToken: string, expiresAt: string, qrPayload: string }
// qrPayload is JSON.stringify({ url, pairingToken, serverName, version })

// Mobile submits pairing token
// POST /api/auth/pair
// Request: { pairingToken: string, deviceName: string, platform: 'ios' | 'android' }
// Response: { success: boolean, token: string, serverName: string }
// Token is a long-lived bearer token for the mobile device
```

### 8.2 Push Notifications

```typescript
// New file: src/web/push.js

// Register device for push
// POST /api/push/register
// Request: { deviceToken: string, platform: 'ios' | 'android' }
// Response: { success: boolean }

// Unregister device
// POST /api/push/unregister
// Request: { deviceToken: string }
// Response: { success: boolean }

// Server-side: when events occur, send push via Expo Push API
// Events that trigger push:
//   - session:updated (status changed to 'stopped' from 'running') -> "Session X completed"
//   - session:updated (needs input detected) -> "Session X needs your input"
//   - conflict detected -> "File conflict in workspace Y"
//   - worktreeTask:updated (status -> 'review') -> "Task Z ready for review"
```

### 8.3 Desktop QR Display

Add to the web UI:
- "Pair Mobile" button in settings
- Modal showing QR code (generated from `/api/auth/pairing-code`)
- Auto-refreshes QR every 5 minutes (tokens expire)
- Shows paired devices list with "Revoke" button

---

## 9. Execution Phases

### Phase 0: Design + Contracts (this session)
- [x] Design document (this file)
- [ ] Implementation plan with exact task breakdown

### Phase 1: Foundation (1 agent, sequential)
- Expo project scaffold in `mobile/`
- TypeScript configuration
- expo-router navigation skeleton (all screens as stubs)
- Theme system (all 13 themes, ThemeProvider, useTheme hook)
- Custom fonts (Plus Jakarta Sans, JetBrains Mono)
- API client (`mobile/src/api/client.ts`) implementing MyrlinAPI interface
- SSE client hook (`useSSE`) feeding TanStack Query cache
- Auth flow (login screen, secure token storage, auto-reconnect)
- Multi-server support (server switcher, SecureStore persistence)
- Onboarding flow (first launch, no servers)
- Shared component library (all components from Section 6.1)
- Toast notification system
- Haptic feedback utility

### Phase 2: Core Screens (2-3 parallel agents)
- **Agent A:** SessionsListScreen + SessionDetailScreen + WorkspacesScreen
- **Agent B:** TerminalScreen (hybrid WebView + native chrome)
- **Agent C:** SettingsScreen + ThemePickerModal + MoreScreen

### Phase 3: Feature Screens (2-3 parallel agents)
- **Agent A:** KanbanBoardScreen + TaskDetailScreen + NewTaskModal
- **Agent B:** CostDashboardScreen (charts, period selector, breakdowns)
- **Agent C:** DocsListScreen + NoteEditorScreen + FeatureBoardScreen

### Phase 4: Advanced Features (2 agents)
- **Agent A:** QR scanning + server pairing + push notifications
- **Agent B:** Search, ConflictCenter, SessionManager, ResourcesScreen

### Phase 5: Native Polish (1-2 agents)
- Animations (reanimated, layout animations, shared element transitions)
- Haptic feedback on all interactions
- Biometric auth (Face ID / fingerprint to unlock app)
- Deep links (myrlin://session/xyz opens session detail)
- Image upload from camera/gallery to terminal
- Voice input (speech-to-text for terminal)
- Offline mode (cached state, reconnection queue)
- Error boundaries and fallback screens

### Phase 6: Platform + Launch
- Android build verification and platform-specific fixes
- App Store assets (screenshots, description, privacy policy)
- Play Store assets
- TestFlight / internal testing
- App Store / Play Store submission

---

## 10. File Structure

```
mobile/
├── app/                          # expo-router pages
│   ├── _layout.tsx               # Root layout (providers, theme)
│   ├── index.tsx                 # Entry redirect (onboarding or tabs)
│   ├── onboarding.tsx            # First launch
│   ├── login.tsx                 # Password entry
│   ├── scan-qr.tsx               # QR code scanner
│   ├── manual-connect.tsx        # URL + password entry
│   └── (tabs)/                   # Authenticated tab navigator
│       ├── _layout.tsx           # Tab bar configuration
│       ├── sessions/
│       │   ├── index.tsx         # Sessions list
│       │   ├── [id].tsx          # Session detail
│       │   └── terminal/[id].tsx # Terminal screen
│       ├── tasks/
│       │   ├── index.tsx         # Kanban board
│       │   └── [id].tsx          # Task detail
│       ├── costs/
│       │   └── index.tsx         # Cost dashboard
│       ├── docs/
│       │   ├── index.tsx         # Docs list
│       │   ├── editor/[id].tsx   # Note editor
│       │   └── board.tsx         # Feature board
│       └── more/
│           ├── index.tsx         # More menu
│           ├── workspaces.tsx    # Manage workspaces
│           ├── resources.tsx     # CPU/memory monitor
│           ├── recent.tsx        # Recent sessions
│           ├── search.tsx        # Global search
│           ├── templates.tsx     # Template management
│           ├── conflicts.tsx     # Conflict center
│           ├── session-manager.tsx # Bulk actions
│           ├── servers.tsx       # Server connections
│           └── settings.tsx      # All settings
├── src/
│   ├── api/
│   │   ├── client.ts             # MyrlinAPI implementation
│   │   ├── sse.ts                # SSE client + React Query sync
│   │   └── types.ts              # All API types (from Section 5)
│   ├── components/
│   │   ├── core/                 # Button, Badge, Card, Input, etc.
│   │   ├── domain/               # SessionCard, KanbanCard, etc.
│   │   └── terminal/             # TerminalView, terminal HTML asset
│   ├── hooks/
│   │   ├── useTheme.ts
│   │   ├── useServer.ts          # Active server connection
│   │   ├── useSSE.ts             # Real-time event subscription
│   │   ├── useSessions.ts        # TanStack Query hooks for sessions
│   │   ├── useWorkspaces.ts
│   │   ├── useTasks.ts
│   │   ├── useCosts.ts
│   │   ├── useDocs.ts
│   │   ├── useAuth.ts
│   │   └── usePush.ts            # Push notification registration
│   ├── stores/
│   │   ├── app.ts                # Zustand: UI state, preferences
│   │   ├── servers.ts            # Zustand: server connections
│   │   └── terminal.ts           # Zustand: terminal state per session
│   ├── theme/
│   │   ├── provider.tsx          # ThemeProvider context
│   │   ├── themes.ts             # All 13 theme definitions
│   │   ├── tokens.ts             # Spacing, radius, typography constants
│   │   └── terminal-themes.ts    # xterm.js theme objects per theme
│   ├── utils/
│   │   ├── haptics.ts            # Haptic feedback helpers
│   │   ├── share.ts              # Native share sheet
│   │   ├── biometrics.ts         # Face ID / fingerprint
│   │   ├── storage.ts            # SecureStore + AsyncStorage wrappers
│   │   ├── formatting.ts         # Date, cost, token formatting
│   │   └── platform.ts           # iOS/Android platform checks
│   └── assets/
│       ├── fonts/                # Plus Jakarta Sans, JetBrains Mono
│       ├── terminal.html         # Minimal xterm.js page for WebView
│       └── images/               # App icon, splash, etc.
├── app.json                      # Expo config
├── package.json
├── tsconfig.json
├── babel.config.js
├── metro.config.js
└── eas.json                      # EAS Build configuration
```

---

## 11. Metrics of Success

| Metric | Target | How to Measure |
|--------|--------|---------------|
| Feature coverage | 100% of web features | Checklist audit against web feature list |
| Cold start | < 2s to first meaningful screen | Profiler |
| Terminal latency | < 100ms input to render | Timestamp measurement |
| Push delivery | < 5s after server event | End-to-end test |
| Offline graceful | Stale data visible, no crashes | Airplane mode test |
| Theme consistency | Pixel-comparable to web | Side-by-side screenshots |
| Navigation depth | Any feature in <= 3 taps | UX audit |
| App size | < 50MB installed | Build output |
| iOS to Android gap | < 2 weeks | Calendar |
| Crash rate | < 0.1% | Expo crash reporting |
| Accessibility | VoiceOver navigable | Manual test |

---

## 12. Future: myrlin.io Relay (Phase 2+, Paid)

Deferred to after the free direct-connect version ships. Architecture sketch:

```
Mobile App <-> myrlin.io WebSocket relay <-> Desktop Myrlin Server

myrlin.io provides:
- User accounts (email + password or OAuth)
- Server registration (desktop registers with myrlin.io)
- Device pairing via QR on myrlin.io website
- WebSocket relay for traffic (no direct LAN needed)
- Billing (Stripe, usage-based or flat monthly)
- Push notification forwarding
- Team features (shared workspaces across users)
```

This is a separate service. Not built in Phase 1.

---

## Appendix A: Web Feature Parity Checklist

Every feature from the web GUI mapped to its mobile equivalent:

| # | Web Feature | Mobile Screen | Mobile Interaction |
|---|-------------|--------------|-------------------|
| 1 | Auth (password + token) | LoginScreen | Native TextInput + SecureStore |
| 2 | Session create | NewSessionModal | Bottom sheet form |
| 3 | Session rename | SessionDetail or ActionSheet | Inline edit or modal |
| 4 | Session start/stop/restart | SessionDetail controls | Buttons + haptic |
| 5 | Session delete (hide) | ActionSheet swipe-to-delete | Swipe left or long press |
| 6 | Session move between workspaces | ActionSheet | Picker in action sheet |
| 7 | Session tags | SessionDetail | Chip editor |
| 8 | Multi-pane terminals | Swipeable single terminal | Swipe between sessions |
| 9 | Terminal input/output | TerminalScreen | Native TextInput + WebView |
| 10 | Terminal activity indicators | Header badge | Activity label in header |
| 11 | Terminal scroll/type modes | Default: scroll. Tap input = type | Native keyboard handling |
| 12 | Terminal voice input | Toolbar mic button | expo-speech / iOS dictation |
| 13 | Terminal image upload | Toolbar camera button | expo-image-picker |
| 14 | Terminal copy/paste | Toolbar buttons + native clipboard | System clipboard |
| 15 | Terminal share | Toolbar share button | Native share sheet |
| 16 | Terminal reader mode | Toolbar reader button | Full-screen scrollable text |
| 17 | Workspace create | NewWorkspaceModal | Bottom sheet form |
| 18 | Workspace rename | WorkspacesScreen | Inline or modal |
| 19 | Workspace delete | ActionSheet | Swipe or long press |
| 20 | Workspace groups | WorkspacesScreen sections | Collapsible sections |
| 21 | Workspace colors | Color picker in create/edit | Color grid selector |
| 22 | Workspace reorder | Drag-and-drop in list | DraggableList |
| 23 | 13 themes | ThemePickerModal | Grid with live preview |
| 24 | Kanban board (5 columns) | KanbanBoardScreen | Horizontal scroll + drag |
| 25 | Task create | NewTaskModal | Bottom sheet form |
| 26 | Task drag between columns | Gesture handler drag | Touch drag with haptic |
| 27 | Task dependencies | TaskDetail + ActionSheet | Set blocker UI |
| 28 | Task PR creation | TaskDetail | Button + form |
| 29 | Task timeline | TaskDetail section | Vertical timeline view |
| 30 | Cost dashboard | CostDashboardScreen | Charts + summary cards |
| 31 | Cost per session | SessionDetail | Embedded cost section |
| 32 | Cost per workspace | CostDashboard | Workspace breakdown |
| 33 | Cost by model | CostDashboard | Model bar chart |
| 34 | Cost timeline | CostDashboard | Line chart |
| 35 | Token bar | SessionDetail + CostDashboard | TokenBar component |
| 36 | Docs (notes/goals/tasks/roadmap/rules) | DocsListScreen | Collapsible sections |
| 37 | Doc item add/edit/delete | DocsListScreen + NoteEditor | Swipe, tap, modal |
| 38 | Feature board | FeatureBoardScreen | Kanban columns |
| 39 | Quick Switcher (Ctrl+K) | SearchBar at top of Sessions | Always-visible search |
| 40 | Global search | SearchScreen | Dedicated search screen |
| 41 | AI search | SearchScreen toggle | AI/Keyword mode toggle |
| 42 | Settings (20+) | SettingsScreen | Categorized list |
| 43 | Auto-trust toggle | Settings | Toggle row |
| 44 | Context menus | ActionSheet | Native iOS action sheet |
| 45 | Templates | TemplatesScreen + NewSession chips | List + quick-launch |
| 46 | Session detail (metadata) | SessionDetailScreen | MetaRow grid |
| 47 | Session logs | SessionDetail section | Scrollable log list |
| 48 | Subagent display | SessionDetail section | Nested list |
| 49 | Resources (CPU/memory) | ResourcesScreen | Live-updating list |
| 50 | Kill process | ResourcesScreen | Swipe-to-kill |
| 51 | Conflict detection | ConflictCenterScreen | List with resolve actions |
| 52 | Session manager (bulk) | SessionManagerScreen | Multi-select + bulk stop |
| 53 | Recent sessions | RecentScreen | Frecency-ranked list |
| 54 | Discovered projects | SessionsListScreen filter | Integrated into session list |
| 55 | Export context | SessionDetail ActionSheet | Share as file |
| 56 | Summarize session | SessionDetail ActionSheet | AI summary |
| 57 | Refocus session | SessionDetail ActionSheet | Form modal |
| 58 | Spinoff tasks | SpinoffModal | AI extraction + checkboxes |
| 59 | Auto-title | SessionDetail ActionSheet | One-tap action |
| 60 | Git status | SessionDetail metadata | Branch + status display |
| 61 | Worktree management | TaskDetail | Merge/reject buttons |
| 62 | Diff viewer | TaskDetail | Scrollable diff view |
| 63 | PR status | KanbanCard + TaskDetail | Badge + status |
| 64 | Model selection | ActionSheet + NewSession | Picker |
| 65 | Flags/permissions | NewSession + ActionSheet | Toggle row |
| 66 | Update checking | Settings | Check + install |
| 67 | Notifications (toast) | Toast system | Bottom toast overlay |
| 68 | Completion notifications | Push + in-app toast | System push notification |
| 69 | SSE real-time updates | useSSE hook | Background sync |
| 70 | Drag-and-drop (sessions) | Long-press + drag in list | Gesture handler |
| 71 | Drag-and-drop (kanban) | Touch drag between columns | Gesture handler |
| 72 | Drag-and-drop (features) | Touch drag between columns | Gesture handler |
| 73 | Inline rename | Tap name to edit | TextInput overlay |
| 74 | Workspace accordion | Collapsible sections | Animated collapse |
| 75 | Session count badge | Tab bar badge | Tab badge count |
| 76 | Needs-input badge | Session card + push | Badge + notification |
| 77 | Cloudflare tunnel config | Settings | Text input + save |
| 78 | Anthropic API key | Settings | Secure text input |
| 79 | td integration | Settings toggle + Tasks tab | td issues section |
| 80 | Folder browser | NewSession directory picker | File tree modal |
| 81 | Image drag-drop to terminal | Camera/gallery button | expo-image-picker |
| 82 | Pane color highlights | Terminal header accent color | Color bar in header |
| 83 | Token pricing display | CostDashboard | Per-model rates |
| 84 | Context usage warning | SessionDetail | Urgency badge |
| 85 | Layout save/restore | N/A (single pane on mobile) | N/A |
| 86 | Sidebar resize | N/A (no sidebar on mobile) | N/A |
| 87 | Multi-pane grid | Swipeable terminal carousel | Horizontal pager |
| 88 | QR code pairing | ScanQRScreen | expo-camera |
| 89 | Manual URL connect | ManualConnectScreen | Form |
| 90 | Multi-server support | ServerSettingsScreen | Server list + switcher |
| 91 | Push notifications | System push | expo-notifications |
| 92 | Biometric auth | App lock | expo-local-authentication |
| 93 | Haptic feedback | All interactions | expo-haptics |
| 94 | Native share sheet | Terminal + sessions | react-native-share |
| 95 | Deep links | myrlin://session/xyz | expo-linking |

Items 85-86 are "N/A" because they are desktop-specific layout concepts that don't apply to mobile (single-pane view replaces multi-pane grid). Item 87 adapts multi-pane into a swipeable carousel.

---

---

## 13. Development Environment

### Build Machine: Mac Mini (arthurs-mac-mini / Tailscale: 100.111.181.106)

All mobile development happens on the Mac Mini:
- Xcode + iOS Simulator for builds and testing
- Node.js 22 (`/opt/homebrew/opt/node@22/bin/node`)
- Expo CLI for development server
- Maestro for automated visual testing
- Physical iPhone connected for Expo Go testing

### Sync Workflow

Code is written in the monorepo on the Windows PC, synced to Mac Mini for building/testing:

```bash
# From Windows PC
rsync -avz --exclude node_modules --exclude .expo mobile/ mac-mini:~/myrlin-workbook/mobile/

# Or: develop directly on Mac Mini via SSH/remote desktop
ssh arthurs-mac-mini "cd ~/myrlin-workbook/mobile && npx expo start"
```

Alternatively, agents can work directly on the Mac Mini via SSH.

### Apple Developer / App Store Connect

- Apple Developer account: active (Shuttle project on TestFlight, Build 8)
- App ID: create `io.myrlin.workbook` (or reuse existing Myrlin Beam/Shuttle bundle IDs)
- EAS Build config for cloud builds (CI), local builds for rapid iteration
- TestFlight for internal testing before App Store submission

---

## 14. UI/UX Evaluation Strategy (NON-NEGOTIABLE)

Every screen built by an agent MUST be visually verified before the phase is marked complete. No blind shipping.

### Evaluation Stack

| Tool | Purpose | When |
|------|---------|------|
| **Maestro** | E2E visual testing on iOS Simulator | After every screen is built |
| **Storybook React Native** | Component isolation + visual QA | During component library build (Phase 1) |
| **Expo Go on iPhone** | Real device feel (haptics, keyboard, gestures) | Manual QA passes |
| **Screenshot diffing** | Compare before/after, catch regressions | CI and agent verification |
| **Claude multimodal review** | Orchestrator views screenshots, identifies issues | After every Maestro run |

### Maestro Test Requirements

Every screen agent builds MUST include a Maestro flow file:

```
mobile/
├── maestro/
│   ├── flows/
│   │   ├── onboarding.yaml
│   │   ├── sessions-list.yaml
│   │   ├── session-detail.yaml
│   │   ├── terminal.yaml
│   │   ├── kanban-board.yaml
│   │   ├── cost-dashboard.yaml
│   │   ├── docs.yaml
│   │   ├── settings.yaml
│   │   └── theme-switching.yaml
│   └── screenshots/        # Maestro output (committed for review)
```

### Agent QA Loop

```
1. Agent builds screen
2. Agent writes Maestro flow YAML for that screen
3. Maestro test runs on iOS Simulator (Mac Mini)
4. Screenshots saved to mobile/maestro/screenshots/
5. Orchestrator reviews screenshots (multimodal image analysis)
6. If visual issues found: agent receives feedback, fixes, re-runs
7. If clean: phase verification passes
```

### Component QA (Storybook)

Phase 1 foundation agent writes Storybook stories for every shared component:

```typescript
// Each component in src/components/core/ gets a .stories.tsx
// Stories cover: default, variants, sizes, states (loading, disabled, error)
// Screenshot each story in Storybook UI
// Compare against Catppuccin design tokens
```

### Physical Device Checklist

Before any App Store submission, manual testing on physical iPhone:
- [ ] Haptic feedback on all interactive elements
- [ ] Face ID / fingerprint unlock
- [ ] Push notification delivery and tap-to-open
- [ ] Real keyboard behavior (autocorrect, dictation, paste)
- [ ] QR code scanning with camera
- [ ] Performance under real network conditions
- [ ] Dark/light theme switching
- [ ] Accessibility (VoiceOver navigation)
- [ ] Orientation lock (portrait only for v1)

---

*Document authored by Claude Opus 4.6 as orchestrator for the Myrlin Mobile build.*
*All agents building this app should reference this document as the source of truth.*
