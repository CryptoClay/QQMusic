"""Wait for an isolated test server without printing response bodies."""

import sys
import time
import urllib.request

for _attempt in range(60):
    try:
        with urllib.request.urlopen(sys.argv[1], timeout=2) as response:
            if response.status == 200:
                print("Acceptance server ready")
                break
    except Exception:
        pass
    time.sleep(1)
else:
    raise SystemExit("Acceptance server failed to start")
