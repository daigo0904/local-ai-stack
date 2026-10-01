import sys
from api import fetch_user
sys.exit(0 if fetch_user(3) == {'id': 3} else 1)
