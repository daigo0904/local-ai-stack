import sys
from utils import clamp
sys.exit(0 if clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0 else 1)
