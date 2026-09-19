"""Windows compatibility for gltest 0.29.2's POSIX stdin temporary file.

Windows cannot unlink a file while fd 0 still refers to it. Defer only that
specific sharing-violation cleanup until process exit; leave VM logic unchanged.
"""
import atexit
import os
from pathlib import Path
import pytest

_held = []
_unlink = os.unlink

@atexit.register
def cleanup_stdin_files():
    for path in _held:
        try:
            _unlink(path)
        except OSError:
            pass

@pytest.fixture(autouse=True)
def windows_gltest_stdin(monkeypatch):
    if os.name != "nt":
        return
    import gltest.direct.loader as loader
    original = loader._inject_message_to_fd0
    def inject(vm):
        def deferred_unlink(path, *args, **kwargs):
            try:
                return _unlink(path, *args, **kwargs)
            except PermissionError as error:
                if error.winerror != 32 or not Path(path).name.startswith("tmp"):
                    raise
                _held.append(path)
        with monkeypatch.context() as local:
            local.setattr(os, "unlink", deferred_unlink)
            original(vm)
    monkeypatch.setattr(loader, "_inject_message_to_fd0", inject)
