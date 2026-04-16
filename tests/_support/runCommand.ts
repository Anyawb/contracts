import { spawnSync } from 'node:child_process';
import path from 'node:path';

const workspaceRoot = '/Volumes/AI-hosts/contracts';

function resolveCommand(binary: string) {
  if (process.platform === 'win32' && !binary.endsWith('.cmd')) {
    return `${binary}.cmd`;
  }
  return binary;
}

export function runCheckedCommand(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(resolveCommand(command), args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: 'utf8',
  });

  if (result.status === 0) {
    return;
  }

  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  const output = [stdout, stderr].filter(Boolean).join('\n');
  throw new Error(
    [`Command failed: ${[command, ...args].join(' ')}`, output].filter(Boolean).join('\n\n'),
  );
}

export function hardhatTest(files: string[]) {
  runCheckedCommand('pnpm', ['-s', 'exec', 'hardhat', 'test', ...files]);
}

export function compileWorkspace() {
  runCheckedCommand('pnpm', ['-s', 'run', 'compile']);
}

export function typecheckProject(tsconfigFile: string) {
  const configPath = path.posix.join(workspaceRoot, tsconfigFile);
  runCheckedCommand('pnpm', ['-s', 'exec', 'tsc', '-p', configPath, '--noEmit']);
}