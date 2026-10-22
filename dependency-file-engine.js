import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SETU_ROOT = dirname(fileURLToPath(import.meta.url));

function combineOpenFlags(...flags) {
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bit masks.
  return flags.reduce((combined, flag) => combined | flag, 0);
}

const STAGED_FILE_FLAGS = combineOpenFlags(
  fsConstants.O_RDONLY,
  fsConstants.O_NOFOLLOW
);
const OUTPUT_DIRECTORY_FLAGS = combineOpenFlags(
  fsConstants.O_RDONLY,
  fsConstants.O_DIRECTORY,
  fsConstants.O_NOFOLLOW
);

export function dependencyFileNativeBinaryPath(setuRoot = SETU_ROOT) {
  return join(resolve(setuRoot), 'bin', 'setu-dependency-files');
}

export function dependencyFileEngineBuildPlan({
  setuRoot = SETU_ROOT,
  cargo = 'cargo',
} = {}) {
  const root = resolve(setuRoot);
  const engineRoot = join(root, 'engines', 'dependency-files');
  return {
    args: [
      'build',
      '--release',
      '--locked',
      '--offline',
      '--manifest-path',
      join(engineRoot, 'Cargo.toml'),
      '--target-dir',
      join(engineRoot, 'target'),
    ],
    builtBinary: join(engineRoot, 'target', 'release', 'setu-dependency-files'),
    command: cargo,
    cwd: engineRoot,
    output: dependencyFileNativeBinaryPath(root),
  };
}

async function runBuild(command, args, options) {
  const result = await exec(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return { stderr: result.stderr, stdout: result.stdout };
}

export async function buildDependencyFileEngine({
  setuRoot = SETU_ROOT,
  cargo = process.env.CARGO || 'cargo',
  processRunner = runBuild,
} = {}) {
  if (process.platform !== 'darwin') {
    throw Object.assign(
      new Error('The dependency-file helper is supported only on macOS'),
      {
        code: 'NATIVE_UNSUPPORTED',
      }
    );
  }

  const plan = dependencyFileEngineBuildPlan({ cargo, setuRoot });
  await processRunner(plan.command, plan.args, { cwd: plan.cwd });
  await mkdir(dirname(plan.output), { mode: 0o755, recursive: true });
  const stagingPath = `${plan.output}.setu-stage-${randomUUID()}`;
  await copyFile(plan.builtBinary, stagingPath, fsConstants.COPYFILE_EXCL);
  await chmod(stagingPath, 0o755);
  const staged = await open(stagingPath, STAGED_FILE_FLAGS);
  try {
    await staged.sync();
  } finally {
    await staged.close();
  }
  await rename(stagingPath, plan.output);
  const outputDirectory = await open(
    dirname(plan.output),
    OUTPUT_DIRECTORY_FLAGS
  );
  try {
    await outputDirectory.sync();
  } finally {
    await outputDirectory.close();
  }
  return { binary: plan.output, built: true };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'build') {
    process.stderr.write('usage: bun dependency-file-engine.js build\n');
    process.exitCode = 2;
    return;
  }

  try {
    process.stdout.write(
      `${JSON.stringify(await buildDependencyFileEngine())}\n`
    );
  } catch (error) {
    const code =
      typeof error.code === 'string' ? error.code : 'NATIVE_BUILD_FAILED';
    process.stderr.write(`${code}: dependency-file helper build failed\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
