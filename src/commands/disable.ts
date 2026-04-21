import type { Command } from 'commander';

import { loadConfig, saveConfig } from '../core/config.js';
import type { AbsolutePath, IdleConfig, ProjectOverride } from '../lib/types.js';

import { projectCwd } from './_shared.js';

export function register(program: Command): void {
  program
    .command('disable')
    .description('Disable Idle for the current project.')
    .action(() => {
      const code = runDisable();
      process.exit(code);
    });
}

export function runDisable(): number {
  let cwd: AbsolutePath;
  try {
    cwd = projectCwd();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const config = loadConfig();
  const override = config.projects[cwd];
  if (override !== undefined && override.enabled === false) {
    process.stdout.write(`Already disabled for ${cwd}.\n`);
    return 0;
  }

  saveConfig(withProjectOverride(config, cwd, { enabled: false }));
  process.stdout.write(`Disabled for ${cwd}.\n`);
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
