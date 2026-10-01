import sys
from pager import page
xs=list(range(25))
sys.exit(0 if page(xs,0)==list(range(10)) and page(xs,2)==[20,21,22,23,24] else 1)
