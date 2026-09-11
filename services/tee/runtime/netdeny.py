"""netdeny: exec a command under a seccomp-bpf filter that denies network sockets.

Usage: python3 netdeny.py <argv...>

Installs (with PR_SET_NO_NEW_PRIVS) a seccomp filter that makes socket(2) fail with EACCES for
every address family except AF_UNIX, and makes io_uring_setup(2) fail (io_uring can open
sockets without socket(2)). x32-ABI syscalls on x86_64 are denied outright; any other
architecture is killed. The filter is inherited by every child and cannot be removed, so the
whole process tree (python, pytest, agent-written code) has no network access. This is the
fallback used inside the EigenCompute container when `unshare --net` is not permitted (no
CAP_SYS_ADMIN); it needs no privileges. Stdlib only.
"""

import ctypes
import os
import platform
import struct
import sys

PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2

BPF_LD_W_ABS = 0x20
BPF_JEQ_K = 0x15
BPF_JGE_K = 0x35
BPF_RET_K = 0x06
RET_ALLOW = 0x7FFF0000
RET_KILL_PROCESS = 0x80000000
RET_ERRNO_EACCES = 0x00050000 | 13
AF_UNIX = 1
X32_BIT = 0x40000000
IO_URING_SETUP = 425

ARCHES = {
    "x86_64": (0xC000003E, 41),  # AUDIT_ARCH_X86_64, __NR_socket
    "amd64": (0xC000003E, 41),
    "aarch64": (0xC00000B7, 198),  # AUDIT_ARCH_AARCH64, __NR_socket
    "arm64": (0xC00000B7, 198),
}


def ins(code, jt, jf, k):
    return struct.pack("HBBI", code, jt, jf, k)


def build_filter(arch, nr_socket):
    prog = [
        ins(BPF_LD_W_ABS, 0, 0, 4),  # 0: A = seccomp_data.arch
        ins(BPF_JEQ_K, 1, 0, arch),  # 1: arch ok -> 3
        ins(BPF_RET_K, 0, 0, RET_KILL_PROCESS),  # 2
        ins(BPF_LD_W_ABS, 0, 0, 0),  # 3: A = nr
        ins(BPF_JGE_K, 5, 0, X32_BIT),  # 4: x32 -> 10
        ins(BPF_JEQ_K, 4, 0, IO_URING_SETUP),  # 5: io_uring_setup -> 10
        ins(BPF_JEQ_K, 0, 2, nr_socket),  # 6: socket -> 7 else -> 9
        ins(BPF_LD_W_ABS, 0, 0, 16),  # 7: A = args[0] (domain, low 32 bits)
        ins(BPF_JEQ_K, 0, 1, AF_UNIX),  # 8: AF_UNIX -> 9 else -> 10
        ins(BPF_RET_K, 0, 0, RET_ALLOW),  # 9
        ins(BPF_RET_K, 0, 0, RET_ERRNO_EACCES),  # 10
    ]
    return b"".join(prog), len(prog)


def install():
    machine = platform.machine().lower()
    if machine not in ARCHES:
        raise SystemExit(f"netdeny: unsupported architecture {machine}")
    arch, nr_socket = ARCHES[machine]
    raw, n = build_filter(arch, nr_socket)
    buf = ctypes.create_string_buffer(raw, len(raw))

    class SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    fprog = SockFprog(n, ctypes.cast(buf, ctypes.c_void_p))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, None, 0, 0) != 0:
        raise SystemExit(f"netdeny: PR_SET_NO_NEW_PRIVS failed: errno {ctypes.get_errno()}")
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0) != 0:
        raise SystemExit(f"netdeny: PR_SET_SECCOMP failed: errno {ctypes.get_errno()}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: netdeny.py <argv...>")
    install()
    os.execvp(sys.argv[1], sys.argv[1:])
