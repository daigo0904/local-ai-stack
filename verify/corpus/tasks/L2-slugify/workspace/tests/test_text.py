import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from text import slugify
sys.exit(0 if slugify('Hello, World!') == 'hello-world' else 1)
