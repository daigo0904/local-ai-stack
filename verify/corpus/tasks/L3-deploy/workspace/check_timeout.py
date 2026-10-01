import json, sys
sys.exit(0 if json.load(open('config.json'))['timeout'] == 30 else 1)
