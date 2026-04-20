import type { Command } from 'commander';

import { NOTIFICATION_METHODS, saveConfig } from '../core/config.js';
import { installHooks } from '../core/settings.js';
import { TONE_PRESETS } from '../lib/types.js';
import type {
  IdleConfig,
  NotificationMethod,
  TonePreset,
} from '../lib/types.js';

import {
  ensureClaudeInstalled,
  formatInstallResult,
  provisionIdleHome,
} from './_shared.js';

interface InitAnswers {
  tonePreset: TonePreset;
  timeMinutes: number;
  toolCalls: number;
  notificationMethod: NotificationMethod;
  confirm: boolean;
}

function toneChoices(): { title: string; value: TonePreset }[] {
  return TONE_PRESETS.map((preset) => ({
    title: preset === 'dry' ? 'dry (default)' : preset,
    value: preset,
  }));
}

function notificationChoices(): { title: string; value: NotificationMethod }[] {
  return NOTIFICATION_METHODS.map((method) => ({ title: method, value: method }));
}

export function register(program: Command): void {
  program
    .command('init')
    .description('Interactive setup. Writes config and installs hooks.')
    .action(async () => {
      const code = await runInit();
      process.exit(code);
    });
}

export async function runInit(): Promise<number> {
  if (!ensureClaudeInstalled()) return 1;

  // Lazy-load: keeps `idle --version` out of the prompts bundle.
  const { default: prompts } = await import('prompts');

  const answers = (await prompts([
    {
      type: 'select',
      name: 'tonePreset',
      message: 'Tone preset',
      choices: toneChoices(),
      initial: 0,
    },
    {
      type: 'number',
      name: 'timeMinutes',
      message: 'Time threshold (minutes)',
      initial: 45,
      min: 0,
    },
    {
      type: 'number',
      name: 'toolCalls',
      message: 'Tool call threshold',
      initial: 40,
      min: 0,
    },
    {
      type: 'select',
      name: 'notificationMethod',
      message: 'Notification method',
      choices: notificationChoices(),
      initial: 0,
    },
    {
      type: 'confirm',
      name: 'confirm',
      message:
        'Write config to ~/.idle/config.toml and install hooks in ~/.claude/settings.json?',
      initial: true,
    },
  ])) as Partial<InitAnswers>;

  // Cancellation (ctrl-C, esc) leaves later answers undefined.
  if (
    answers.tonePreset === undefined ||
    answers.timeMinutes === undefined ||
    answers.toolCalls === undefined ||
    answers.notificationMethod === undefined ||
    !answers.confirm
  ) {
    process.stdout.write('Cancelled.\n');
    return 0;
  }

  const config: IdleConfig = {
    thresholds: {
      time_minutes: answers.timeMinutes,
      tool_calls: answers.toolCalls,
    },
    tone: { preset: answers.tonePreset },
    notifications: { method: answers.notificationMethod, sound: false },
    projects: {},
  };

  // Hooks first, config second — a failed install must not leave a
  // stray config.toml behind (PRD §6.1 "restore exact prior state").
  const result = await installHooks();
  if (!result.ok) return formatInstallResult(result);
  saveConfig(config);
  provisionIdleHome();
  return formatInstallResult(result);
}
