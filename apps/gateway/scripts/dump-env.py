import json
import os
import sys

keys = sorted(os.environ)
print(json.dumps({k: os.environ[k] for k in keys}, ensure_ascii=False))
