import os
import sys

# Make `base` and `app` importable the same way main.py does.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
