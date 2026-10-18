import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentSessionLaunch,
  parseSessionRegistration,
} from './agent-session-launcher.js';

test('the Ghostty launcher keeps the supported open invocation and registers the coding pid', () => {
  const launch = buildAgentSessionLaunch({
    checkoutPath: '/work/repo/topic',
    command: 'codex',
    launcherPath: '/tmp/setu-session-launch.sh',
    registrationPath: '/tmp/setu-session-registration.json',
    sessionId: 'session-1',
  });

  expect(launch.args).toEqual([
    'open',
    '-na',
    'Ghostty',
    '--args',
    '--working-directory=/work/repo/topic',
    '--command=/tmp/setu-session-launch.sh',
  ]);
  expect(launch.script).toContain('codex <&0 &');
  expect(launch.script).toContain('agent_pid=$!');
  expect(launch.script).toContain('setopt monitor');
  expect(launch.script).toContain('fg %+');
  expect(launch.script).toContain('/tmp/setu-session-registration.json');
  expect(launch.script).toContain('exec zsh -l');
});

test('registration parsing accepts only the expected session and pid identity', () => {
  expect(
    parseSessionRegistration(
      '{"id":"session-1","pid":321,"processStart":"Mon Sep 21 10:11:12 2026"}',
      'session-1'
    )
  ).toEqual({
    id: 'session-1',
    pid: 321,
    processStart: 'Mon Sep 21 10:11:12 2026',
  });
  expect(
    parseSessionRegistration(
      '{"id":"other","pid":321,"processStart":"Mon Sep 21 10:11:12 2026"}',
      'session-1'
    )
  ).toBeNull();
  expect(
    parseSessionRegistration('{"id":"session-1","pid":0}', 'session-1')
  ).toBeNull();
});

test('a private launch token binds the launcher registration without persisting it in the result', () => {
  const launch = buildAgentSessionLaunch({
    checkoutPath: '/work/repo/topic',
    command: 'codex',
    launcherPath: '/tmp/setu-session-launch.sh',
    launchToken: 'token_1234567890123456',
    registrationPath: '/tmp/setu-session-registration.json',
    sessionId: 'session-1',
  });
  expect(launch.script).toContain('SETU_SESSION_TOKEN');
  expect(
    parseSessionRegistration(
      '{"id":"session-1","pid":321,"processStart":"Mon Sep 21 10:11:12 2026","launchToken":"token_1234567890123456"}',
      { launchToken: 'token_1234567890123456', sessionId: 'session-1' }
    )
  ).toEqual({
    id: 'session-1',
    pid: 321,
    processStart: 'Mon Sep 21 10:11:12 2026',
  });
});

test('the pure builder refuses paths and commands that cannot be represented safely', () => {
  expect(() =>
    buildAgentSessionLaunch({
      checkoutPath: '/work/repo',
      command: 'codex\nrm -rf /',
      launcherPath: '/tmp/launch',
      registrationPath: '/tmp/registration',
      sessionId: 'session-1',
    })
  ).toThrow();
});

test('the generated launcher keeps an owned coding process foreground in a pty and quotes apostrophe paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-launcher-'));
  try {
    const checkoutPath = join(root, "checkout's-name");
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const launcherPath = join(root, 'launch.zsh');
    const ptyRunnerPath = join(root, 'pty-runner.py');
    const registrationPath = join(root, 'registration.json');
    const transcriptPath = join(root, 'transcript');
    const agentPath = join(root, 'agent');
    const inputPath = join(root, 'input');
    const pidPath = join(root, 'pid');
    const pwdPath = join(root, 'pwd');
    const ttyPath = join(root, 'tty');
    fs.mkdirSync(checkoutPath);
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.writeFileSync(join(home, '.zshrc'), '');
    fs.writeFileSync(
      join(bin, 'ps'),
      '#!/bin/sh\nprintf "  Mon Sep 21 10:10:00 2026  \\n"\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      agentPath,
      '#!/bin/sh\nprintf "%s" "$$" > "$PID_PATH"\n' +
        'if [ -t 0 ]; then printf tty > "$TTY_PATH"; else printf notty > "$TTY_PATH"; fi\n' +
        'IFS= read -r input\nprintf "%s" "$input" > "$INPUT_PATH"\npwd > "$PWD_PATH"\n',
      { mode: 0o755 }
    );
    const launch = buildAgentSessionLaunch({
      checkoutPath,
      command: agentPath,
      launcherPath,
      registrationPath,
      sessionId: 'session-pty',
    });
    fs.writeFileSync(launcherPath, launch.script, { mode: 0o700 });
    fs.writeFileSync(
      ptyRunnerPath,
      'import os, pty, select, signal, sys, time\n' +
        'pid, terminal = pty.fork()\n' +
        'if pid == 0:\n' +
        '    os.execvpe(sys.argv[1], [sys.argv[1]], os.environ)\n' +
        'started = time.monotonic()\n' +
        'sent_input = False\n' +
        'sent_exit = False\n' +
        'transcript = b""\n' +
        'deadline = time.monotonic() + 3\n' +
        'while True:\n' +
        '    if not sent_input and time.monotonic() - started > 0.25:\n' +
        '        os.write(terminal, b"from-terminal\\n")\n' +
        '        sent_input = True\n' +
        '    if time.monotonic() > deadline:\n' +
        '        os.kill(pid, 9)\n' +
        '        _, status = os.waitpid(pid, 0)\n' +
        '        sys.exit(99)\n' +
        '    try:\n' +
        '        ready, _, _ = select.select([terminal], [], [], 0.1)\n' +
        '        if ready:\n' +
        '            data = os.read(terminal, 1024)\n' +
        '            transcript += data\n' +
        '            with open(os.environ["TRANSCRIPT_PATH"], "ab") as output_file:\n' +
        '                output_file.write(data)\n' +
        '            if sent_input and not sent_exit and os.path.exists(os.environ["PWD_PATH"]) and b"% " in transcript:\n' +
        '                os.kill(pid, signal.SIGKILL)\n' +
        '                os.waitpid(pid, 0)\n' +
        '                sys.exit(0)\n' +
        '    except OSError:\n' +
        '        break\n' +
        '_, status = os.waitpid(pid, 0)\n' +
        'sys.exit(os.waitstatus_to_exitcode(status))\n'
    );
    const child = spawn('python3', [ptyRunnerPath, launcherPath], {
      env: {
        ...process.env,
        HOME: home,
        INPUT_PATH: inputPath,
        PATH: `${bin}:${process.env.PATH}`,
        PID_PATH: pidPath,
        PWD_PATH: pwdPath,
        TRANSCRIPT_PATH: transcriptPath,
        TTY_PATH: ttyPath,
      },
      stdio: 'ignore',
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const outcome = await exited;
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    expect(fs.readFileSync(ttyPath, 'utf8')).toBe('tty');
    expect(fs.readFileSync(inputPath, 'utf8')).toBe('from-terminal');
    expect(fs.readFileSync(pwdPath, 'utf8').trim()).toBe(checkoutPath);
    expect(
      parseSessionRegistration(
        fs.readFileSync(registrationPath, 'utf8'),
        'session-pty'
      )
    ).toMatchObject({
      pid: Number(fs.readFileSync(pidPath, 'utf8')),
      processStart: 'Mon Sep 21 10:10:00 2026',
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}, 5000);
