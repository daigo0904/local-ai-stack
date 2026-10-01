import sys
from slow import count_primes
sys.exit(0 if count_primes(100) == 25 else 1)
