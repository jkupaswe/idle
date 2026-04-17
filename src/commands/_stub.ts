/**
 * Stub action for CLI subcommands that haven't been implemented yet.
 * Later tickets (T-014, T-015, T-016) replace each stub with real logic.
 */

export function notImplemented(name: string): never {
  process.stderr.write(`idle: ${name} not yet implemented\n`);
  process.exit(1);
}
