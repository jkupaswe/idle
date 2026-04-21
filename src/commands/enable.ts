import type { Command } from 'commander';

import { loadConfig, saveConfig } from '../core/config.js';
import type { AbsolutePath, IdleConfig, ProjectOverride } from '../lib/types.js';

import { projectCwd } from './_shared.js';

export function register(program: Command): void {
  program
    .command('enable')
    .description('Enable Idle for the current project.')
    .action(() => {
      const code = runEnable();
      process.exit(code);
    });
}

export function runEnable(): number {
  let cwd: AbsolutePath;
  try {
    cwd = projectCwd();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const config = loadConfig();
  const override = config.projects[cwd];
  if (override === undefined || override.enabled === true) {
    process.stdout.write(`Already enabled for ${cwd}.\n`);
    return 0;
  }

  saveConfig(withProjectOverride(config, cwd, { enabled: true }));
  process.stdout.write(`Enabled for ${cwd}.\n`);
  return 0;
}

function withProjectOverride(
  config: Readonly<IdleConfig>,
  cwd: AbsolutePath,
  override: ProjectOverride,
): IdleConfig {
  const projects: Record<AbsolutePath, ProjectOverride> = {
    ...config.projects,
    [cwd]: override,
  };
  return {
    thresholds: { ...config.thresholds },
    tone: { ...config.tone },
    notifications: { ...config.notifications },
    projects,
  };
}
