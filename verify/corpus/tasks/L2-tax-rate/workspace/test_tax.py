import sys
from tax import with_tax
sys.exit(0 if with_tax(100)==110 else 1)
