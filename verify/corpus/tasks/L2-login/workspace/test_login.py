import sys
from auth import login
sys.exit(0 if not login('admin', 'wrong') else 1)
