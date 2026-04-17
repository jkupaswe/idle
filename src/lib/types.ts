/**
 * Shared TypeScript types for Idle.
 *
 * Covers:
 * - Claude Code hook payload shapes (SessionStart, PostToolUse, Stop, SessionEnd)
 * - Idle on-disk config (`~/.idle/config.toml`)
 * - Idle on-disk state (`~/.idle/state.json`)
 * - Tone presets
 *
 * Hook payload shapes follow the current Claude Code hooks reference
 * (https://code.claude.com/docs/en/hooks). Fields the reference marks as
 * optional are typed as optional here. Hook scripts must still defensively
 * guard against missing fields — the schema has evolved.
 */

// ---------------------------------------------------------------------------
// Tone presets
// ---------------------------------------------------------------------------

/** The four tone presets, selected via config. */
export type TonePreset = 'dry' | 'earnest' | 'absurdist' | 'silent';

/** Runtime-checkable list of valid tone preset values. */
export const TONE_PRESETS: readonly TonePreset[] = [
  'dry',
  'earnest',
  'absurdist',
  'silent',
] as const;

// ---------------------------------------------------------------------------
// Claude Code hook payloads
// ---------------------------------------------------------------------------

/**
 * Fields common to every hook payload Claude Code writes to stdin.
 *
 * `hook_event_name` is the discriminator.
 */
export interface HookPayloadBase {
  /** Unique ID for the Claude Code session that fired this hook. */
  session_id: string;
  /** Absolute path to the running transcript file for this session. */
  transcript_path: string;
  /** Current working directory of the Claude Code process. */
  cwd: string;
  /** The hook event that fired. */
  hook_event_name: string;
}

/** `SessionStart` fires once at the beginning of a Claude Code session. */
export interface SessionStartPayload extends HookPayloadBase {
  hook_event_name: 'SessionStart';
  /** How the session was launched, when Claude Code exposes it. */
  source?: string;
}

/** `PostToolUse` fires after every tool call the agent completes. */
export interface PostToolUsePayload extends HookPayloadBase {
  hook_event_name: 'PostToolUse';
  /** Name of the tool that was invoked (e.g. `"Bash"`, `"Read"`). */
  tool_name: string;
  /** Arbitrary tool input payload. Shape varies per tool. */
  tool_input: Record<string, unknown>;
  /** Arbitrary tool response payload. Shape varies per tool. */
  tool_response?: unknown;
}

/** `Stop` fires when the agent finishes responding to the user's turn. */
export interface StopPayload extends HookPayloadBase {
  hook_event_name: 'Stop';
  /** True when Claude Code is re-invoking Stop after a previous hook fired. */
  stop_hook_active?: boolean;
}

/** `SessionEnd` fires when the Claude Code session terminates. */
export interface SessionEndPayload extends HookPayloadBase {
  hook_event_name: 'SessionEnd';
  /** Reason for session termination, when Claude Code exposes it. */
  reason?: string;
}

/** Discriminated union of every hook payload Idle listens for. */
export type HookPayload =
  | SessionStartPayload
  | PostToolUsePayload
  | StopPayload
  | SessionEndPayload;

// ---------------------------------------------------------------------------
// Config (`~/.idle/config.toml`)
// ---------------------------------------------------------------------------

/** Thresholds that trigger a check-in. A value of 0 disables that threshold. */
export interface ThresholdsConfig {
  /** Minutes elapsed since the last check-in. 0 disables. */
  time_minutes: number;
  /** Tool calls since the last check-in. 0 disables. */
  tool_calls: number;
}

/** Voice/tone settings. */
export interface ToneConfig {
  /** Which prompt template to use for break suggestions. */
  preset: TonePreset;
}

/** How the user gets notified. */
export type NotificationMethod = 'native' | 'terminal' | 'both';

/** Notification delivery settings. */
export interface NotificationsConfig {
  /** Delivery channel. */
  method: NotificationMethod;
  /** Whether to play a sound with native notifications. */
  sound: boolean;
}

/** Per-project override. Keyed by absolute project path in the parent map. */
export interface ProjectOverride {
  /** When false, Idle does nothing for sessions rooted in this project. */
  enabled: boolean;
}

/**
 * Full Idle config, as loaded from `~/.idle/config.toml`.
 *
 * Matches PRD §6.2. Unknown top-level keys are preserved on round-trip by
 * `saveConfig` so users can add their own TOML sections without losing them.
 */
export interface IdleConfig {
  thresholds: ThresholdsConfig;
  tone: ToneConfig;
  notifications: NotificationsConfig;
  /** Per-project overrides keyed by absolute project path. */
  projects: Record<string, ProjectOverride>;
}

// ---------------------------------------------------------------------------
// State (`~/.idle/state.json`)
// ---------------------------------------------------------------------------

/**
 * Live state for a single Claude Code session.
 *
 * Matches PRD §6.3, with additional transient flags written by hooks:
 * `disabled`, `pending_checkin`, `last_tool_name`, `last_tool_summary`.
 */
export interface SessionEntry {
  /** ISO-8601 timestamp of session start. */
  started_at: string;
  /** Absolute path of the project directory (`cwd` at SessionStart). */
  project_path: string;
  /** Tool calls since the last check-in fired (reset on each check-in). */
  tool_calls_since_checkin: number;
  /** Total tool calls observed this session. */
  total_tool_calls: number;
  /** ISO-8601 timestamp of the last check-in, or null if none yet. */
  last_checkin_at: string | null;
  /** ISO-8601 timestamps of every check-in fired this session. */
  checkins: string[];
  /** True when the project is disabled via config — hooks short-circuit. */
  disabled?: boolean;
  /** Set by PostToolUse when a threshold trips; read by Stop. */
  pending_checkin?: boolean;
  /** Name of the most recent tool call. Populated by PostToolUse. */
  last_tool_name?: string;
  /** Short summary of the most recent tool input (<=200 chars). */
  last_tool_summary?: string;
}

/** On-disk shape of `~/.idle/state.json`. */
export interface SessionState {
  /** Keyed by Claude Code `session_id`. */
  sessions: Record<string, SessionEntry>;
}

// ---------------------------------------------------------------------------
// Prompt template input
// ---------------------------------------------------------------------------

/**
 * Stats passed to tone-preset prompt templates when composing the
 * break-suggestion prompt. See `src/prompts/*`.
 */
export interface CheckInStats {
  /** Session duration in minutes at the time of the check-in. */
  duration_minutes: number;
  /** Tool calls accumulated since the last check-in. */
  tool_calls: number;
  /** Name of the most recent tool, if known. */
  last_tool_name?: string;
  /** Short summary of the most recent tool input, if known. */
  last_tool_summary?: string;
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

/** Severity level accepted by the `log()` helper. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
