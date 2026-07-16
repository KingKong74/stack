#!/usr/bin/env python3
# Stack web terminal — the PTY shim.
#
# The daemon (stack-term.mjs) is pure JS and can't allocate a pseudo-terminal
# without native modules the host may not be able to build (node-pty needs a
# toolchain). Python's stdlib can, so this tiny bridge owns the pty:
#
#   argv:  pty-shim.py <cwd> <cmd> [args…]
#   fd 0:  raw keystrokes in  -> written to the pty master
#   fd 1:  raw pty output     -> streamed back to the daemon
#   fd 3:  control channel    -> lines "R <cols> <rows>\n" resize the pty
#
# Exits with the child's exit code. No secrets pass through here — auth
# happened in the daemon before this ever spawns.
import fcntl
import os
import pty
import select
import struct
import sys
import termios

cwd = sys.argv[1]
argv = sys.argv[2:]

pid, master = pty.fork()
if pid == 0:  # child — become the shell/claude session
    try:
        os.chdir(cwd)
    except OSError:
        pass
    os.environ.setdefault('TERM', 'xterm-256color')
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        sys.stderr.write(f'exec failed: {e}\n')
        os._exit(127)

CTRL = 3


def set_size(cols, rows):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass


watch = [master, 0, CTRL]
ctrl_buf = b''
while True:
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if not data:  # session ended
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:  # daemon hung up — take the session down
            try:
                os.kill(pid, 15)
            except OSError:
                pass
            break
        os.write(master, data)
    if CTRL in ready:
        data = os.read(CTRL, 1024)
        if not data:
            watch.remove(CTRL)  # control closed; keep the session alive
            continue
        ctrl_buf += data
        while b'\n' in ctrl_buf:
            line, ctrl_buf = ctrl_buf.split(b'\n', 1)
            parts = line.split()
            if len(parts) == 3 and parts[0] == b'R':
                try:
                    set_size(int(parts[1]), int(parts[2]))
                except ValueError:
                    pass

try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError:
    sys.exit(0)
