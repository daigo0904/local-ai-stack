import sys
src = open("app.py").read()
sys.exit(1 if "print(" in src else 0)
