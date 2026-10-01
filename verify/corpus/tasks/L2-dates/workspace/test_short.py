import sys
from dates import parse_date
sys.exit(0 if parse_date('2024-1-5') == (2024, 1, 5) else 1)
