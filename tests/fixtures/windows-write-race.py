from pathlib import Path
import os
import runpy
import sys


publish = runpy.run_path("workers/files/windows_write.py")["publish"]
root = Path(sys.argv[1])
moved = root.with_name("safe-moved")
original = int(sys.argv[2])


def try_swapping_open_root():
    try:
        root.rename(moved)
    except OSError as error:
        assert error.winerror in (5, 32), error
    else:
        raise AssertionError("The live root could be moved during publication")


publish(str(root), "notes.txt", b"pinned", original, try_swapping_open_root)
root.rename(moved)
root.mkdir()
try:
    publish(str(root), "notes.txt", b"replaced", original)
except ValueError:
    pass
else:
    raise AssertionError("The root identity check accepted a replacement")


def create_collision():
    (root / "COLLISION.TXT").write_bytes(b"existing")


try:
    publish(str(root), "collision.txt", b"overwrite", os.stat(root).st_ino, create_collision)
except OSError as error:
    assert error.winerror in (80, 183), error
else:
    raise AssertionError("The rename replaced a colliding destination")
assert (root / "COLLISION.TXT").read_bytes() == b"existing"
