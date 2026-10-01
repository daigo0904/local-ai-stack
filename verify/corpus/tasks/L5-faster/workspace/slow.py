def count_primes(n):
    return sum(1 for k in range(2, n) if all(k % d for d in range(2, k)))
