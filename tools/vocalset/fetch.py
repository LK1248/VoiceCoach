"""Download individual files from the VocalSet zip on Zenodo using HTTP range
requests, so only the needed recordings are fetched (not the 2 GB archive).

VocalSet: Wilkins, Seetharaman, Wahl, Pardo (2018). CC BY 4.0.
https://zenodo.org/records/1442513
"""
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://zenodo.org/records/1442513/files/VocalSet11.zip?download=1"
CACHE = Path(__file__).parent / ".cache"


class HttpFile(io.RawIOBase):
    """Seekable read-only file backed by HTTP range requests."""

    def __init__(self, url):
        self.url = url
        self.pos = 0
        self.fetched = 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"))
        self.size = int(head.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        if self.pos >= self.size or not len(b):
            return 0
        end = min(self.size, self.pos + len(b)) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        data = urllib.request.urlopen(req).read()
        b[: len(data)] = data
        self.pos += len(data)
        self.fetched += len(data)
        return len(data)


def open_zip():
    f = HttpFile(URL)
    return f, zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 16))


def fetch(names):
    """Fetch zip members into the cache (skipping ones already cached). Returns local paths."""
    CACHE.mkdir(exist_ok=True)
    todo = [n for n in names if not (CACHE / Path(n).name).exists()]
    if todo:
        f, z = open_zip()
        for n in todo:
            (CACHE / Path(n).name).write_bytes(z.read(n))
        print(f"downloaded {len(todo)} files, {f.fetched / 1e6:.1f} MB", file=sys.stderr)
    return [CACHE / Path(n).name for n in names]


if __name__ == "__main__":
    for p in fetch(sys.argv[1:]):
        print(p)
