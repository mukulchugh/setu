import { describe, expect, test } from 'bun:test';
import {
  dependencyFileEngineBuildPlan,
  dependencyFileNativeBinaryPath,
} from './dependency-file-engine.js';

describe('dependency-file-engine build plan', () => {
  test('builds only the std-only helper with locked Cargo inputs and the managed Setu binary destination', () => {
    const plan = dependencyFileEngineBuildPlan({
      cargo: '/opt/rust/bin/cargo',
      setuRoot: '/opt/setu',
    });

    expect(plan.command).toBe('/opt/rust/bin/cargo');
    expect(plan.cwd).toBe('/opt/setu/engines/dependency-files');
    expect(plan.args).toEqual([
      'build',
      '--release',
      '--locked',
      '--offline',
      '--manifest-path',
      '/opt/setu/engines/dependency-files/Cargo.toml',
      '--target-dir',
      '/opt/setu/engines/dependency-files/target',
    ]);
    expect(plan.output).toBe('/opt/setu/bin/setu-dependency-files');
  });

  test('resolves the runtime helper only inside the checked-out Setu tree', () => {
    expect(dependencyFileNativeBinaryPath('/opt/setu')).toBe(
      '/opt/setu/bin/setu-dependency-files'
    );
  });
});
