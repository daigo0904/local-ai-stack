import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from stats import average
sys.exit(0 if average([]) == 0 and average([1, 2, 3]) == 2 else 1)
