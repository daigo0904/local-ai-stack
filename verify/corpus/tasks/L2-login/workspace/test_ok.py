import sys
from auth import login
sys.exit(0 if login('admin', 'secret') else 1)
