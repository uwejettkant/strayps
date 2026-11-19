#!/usr/bin/env python3
"""Drives a command inside a real pseudo-terminal and shows what a user would see.

The full-screen view of agent-leash only exists on a real terminal. This script gives it one,
types into it, and prints the screen as text, so the view can be checked without a human
(used by the scenario-testing skill, see .agents/skills/scenario-testing/SKILL.md).

usage: pty-drive.py [--cols N] [--rows N] [--cwd DIR] -- <command...> :: <step> <step> ...

Steps:
  wait:<seconds>       let the program run
  type:<text>          type text (no Enter)
  key:<name>           enter | tab | esc | up | down | backspace |
                       ctrl-c | ctrl-d | ctrl-u | ctrl-w | ctrl-l | ctrl-z
  screen[:label]       print the current screen contents (escape codes interpreted)
  raw[:label]          print the raw bytes received since the last raw/screen step
  signal:<NAME>        send a signal to the program (INT, TERM, HUP)
  resize:<cols>x<rows> change the terminal size

At the end it reports the exit code and whether the terminal was given back in order
(alternate screen left, cursor visible, line wrap on, echo and canonical mode restored).

Example (safe: --demo touches no files and no real processes):

  python3 scripts/scenarios/pty-drive.py --cols 110 --rows 32 -- \
    node dist/cli.js watch --demo --no-dashboard :: \
    wait:8 screen:story type:clean key:enter screen:confirm type:y screen:done type:exit key:enter

Never drive kill or pause against an instance that runs without --demo.
POSIX only (pty, termios).
"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

KEYS = {
    'enter': b'\r', 'tab': b'\t', 'esc': b'\x1b', 'up': b'\x1b[A', 'down': b'\x1b[B',
    'ctrl-c': b'\x03', 'ctrl-d': b'\x04', 'ctrl-u': b'\x15', 'ctrl-l': b'\x0c',
    'ctrl-w': b'\x17', 'ctrl-z': b'\x1a', 'backspace': b'\x7f',
}


class Screen:
    """A deliberately small terminal emulator: enough to see what the TUI draws."""

    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.alt = False
        self.cursor_visible = True
        self.wrap = True
        self.reset()

    def reset(self):
        self.grid = [[' '] * self.cols for _ in range(self.rows)]
        self.r = self.c = 0

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.reset()

    def feed(self, text):
        # A read can end in the middle of an escape sequence: keep the tail for the next read
        text = getattr(self, 'pending', '') + text
        self.pending = ''
        cut = text.rfind('\x1b')
        if cut != -1 and not re.match(r'\x1b(\[[0-9;?]*[@-~]|\][^\x07]*\x07|[^\[\]])', text[cut:]):
            self.pending = text[cut:]
            text = text[:cut]
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == '\x1b':
                m = re.match(r'\x1b\[([0-9;?]*)([@-~])', text[i:])
                if m:
                    self.csi(m.group(1), m.group(2))
                    i += m.end()
                    continue
                m = re.match(r'\x1b\][^\x07]*\x07', text[i:])
                if m:
                    i += m.end()
                    continue
                i += 2
                continue
            if ch == '\r':
                self.c = 0
            elif ch == '\n':
                self.r = min(self.rows - 1, self.r + 1)
            elif ch == '\b':
                self.c = max(0, self.c - 1)
            elif ch >= ' ':
                if self.c < self.cols:
                    self.grid[self.r][self.c] = ch
                    self.c += 1
                elif self.wrap:
                    self.c = 0
                    self.r = min(self.rows - 1, self.r + 1)
                    self.grid[self.r][self.c] = ch
                    self.c = 1
            i += 1

    def csi(self, params, final):
        if params.startswith('?'):
            for code in params[1:].split(';'):
                on = final == 'h'
                if code == '1049':
                    self.alt = on
                    self.reset()
                elif code == '25':
                    self.cursor_visible = on
                elif code == '7':
                    self.wrap = on
            return
        nums = [int(p) if p else 0 for p in params.split(';')] if params else []
        if final == 'H':
            self.r = min(self.rows - 1, max(0, (nums[0] if nums else 1) - 1))
            self.c = min(self.cols - 1, max(0, (nums[1] if len(nums) > 1 else 1) - 1))
        elif final == 'J':
            self.reset() if (nums[0] if nums else 0) == 2 else None
        elif final == 'K':
            for x in range(self.c, self.cols):
                self.grid[self.r][x] = ' '
        # 'm' (colors) and everything else: ignored

    def dump(self):
        return '\n'.join(''.join(row).rstrip() for row in self.grid)


def main():
    args = sys.argv[1:]
    cols, rows, cwd = 110, 34, None
    while args and args[0].startswith('--') and args[0] != '--':
        if args[0] == '--cols': cols = int(args[1]); args = args[2:]
        elif args[0] == '--rows': rows = int(args[1]); args = args[2:]
        elif args[0] == '--cwd': cwd = args[1]; args = args[2:]
        else: break
    assert args[0] == '--', 'expected -- before the command'
    split = args.index('::')
    command, steps = args[1:split], args[split + 1:]

    pid, fd = pty.fork()
    if pid == 0:
        if cwd: os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.environ.pop('NO_COLOR', None)
        os.execvp(command[0], command)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    before = termios.tcgetattr(fd)

    screen = Screen(cols, rows)
    raw_since = ''
    everything = ''
    status = None

    def pump(seconds):
        nonlocal raw_since, everything, status
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b''
                if not data:
                    break
                text = data.decode('utf-8', 'replace')
                raw_since += text
                everything += text
                screen.feed(text)
            if status is None:
                done, st = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = st

    pump(0.3)
    for step in steps:
        name, _, arg = step.partition(':')
        if name == 'wait':
            pump(float(arg))
        elif name == 'type':
            os.write(fd, arg.encode()); pump(0.25)
        elif name == 'key':
            os.write(fd, KEYS[arg]); pump(0.35)
        elif name == 'signal':
            os.kill(pid, getattr(signal, 'SIG' + arg)); pump(0.5)
        elif name == 'resize':
            c, r = arg.split('x'); cols, rows = int(c), int(r)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            screen.resize(cols, rows)
            os.kill(pid, signal.SIGWINCH); pump(0.5)
        elif name == 'screen':
            print(f"\n┏━━ screen {arg or ''} ({'alternate' if screen.alt else 'normal'} buffer, {cols}x{rows}) " + '━' * 20)
            print(screen.dump())
            print('┗' + '━' * 60)
            raw_since = ''
        elif name == 'raw':
            print(f"\n--- raw {arg or ''} ---")
            print(repr(raw_since[-1500:]))
            raw_since = ''
        else:
            raise SystemExit(f'unknown step {step}')

    # give it a moment to finish if it is on its way out
    for _ in range(40):
        if status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
        if status is not None: break
        pump(0.1)
        time.sleep(0.05)
    alive = status is None
    if alive:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    try:
        after = termios.tcgetattr(fd)
        restored = (after[3] & (termios.ICANON | termios.ECHO)) == (before[3] & (termios.ICANON | termios.ECHO))
    except termios.error:
        restored = None
    code = os.waitstatus_to_exitcode(status)
    tail = everything[-400:]
    print('\n=== result ===')
    print(f"still running at the end (had to kill): {alive}")
    print(f"exit code: {code}")
    print(f"left alternate screen: {not screen.alt} | cursor visible: {screen.cursor_visible} | line wrap on: {screen.wrap}")
    print(f"terminal back in cooked mode (echo + canonical): {restored}")
    print('last output on the normal screen:')
    print(re.sub(r'\x1b\[[0-9;?]*[@-~]', '', tail).strip()[-700:])


if __name__ == '__main__':
    main()
