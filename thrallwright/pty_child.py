"""Acquire the PTY as the controlling terminal in an isolated exec helper.

The parent starts this with start_new_session=True and the slave on fd 0/1/2.
A fresh interpreter avoids Python preexec_fn/fork callbacks in the server.
"""
import fcntl
import os
import sys
import termios

if __name__ == "__main__":
    try:
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        os.tcsetpgrp(0, os.getpgrp())
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    except (OSError, IndexError) as exc:
        print(f"Thrallwright could not launch the command: {exc}", file=sys.stderr)
        sys.exit(127)
