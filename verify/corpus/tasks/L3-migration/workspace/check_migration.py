import glob, sys
fs = [f for f in glob.glob('migrations/*.sql') if not f.endswith('001_init.sql')]
sys.exit(0 if any('last_login' in open(f).read().lower() for f in fs) else 1)
