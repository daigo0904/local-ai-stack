import re

def parse_date(s):
    m = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', s)
    if not m:
        raise ValueError(s)
    return tuple(int(x) for x in m.groups())
