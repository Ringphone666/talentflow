"""Check the intended Git release for common secrets and unintended data files.

This is a reproducible hygiene check, not proof of ownership or a complete DLP system.
Findings name files and rule types; never print matched credential values.
"""
from pathlib import Path
import ipaddress
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', '.venv', 'node_modules', '__pycache__', '.pytest_cache', 'test-data', 'dist', 'data', '.secrets'}
TOKEN = re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}')
PRIVATE_KEY = re.compile('-----BEGIN ' + r'(?:RSA |OPENSSH |EC )?PRIVATE KEY-----')
IP = re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b')

def paths():
    process = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True)
    if process.returncode == 0 and process.stdout:
        return [ROOT / p for p in process.stdout.decode().split('\0') if p]
    return [p for p in ROOT.rglob('*') if p.is_file() and not SKIP.intersection(p.relative_to(ROOT).parts)
            and p.suffix not in ('.pdf', '.docx', '.pyc', '.tsbuildinfo')]

def main():
    findings = []
    selected = paths()
    for path in selected:
        rel = path.relative_to(ROOT)
        if (SKIP.intersection(rel.parts) or path.name.startswith('.env') and path.name != '.env.example'
                or path.suffix.lower() in ('.db', '.sqlite', '.sqlite3', '.dpapi', '.pem', '.key', '.zip', '.pdf', '.docx')):
            findings.append((str(rel), 'runtime data or unexpected attachment'))
            continue
        try:
            content = path.read_text(encoding='utf-8-sig')
        except UnicodeError:
            if not (rel.parts[:2] == ('docs', 'assets') and path.suffix in ('.png', '.jpg', '.webp')):
                findings.append((str(rel), 'unreviewed binary'))
            continue
        if TOKEN.search(content) or PRIVATE_KEY.search(content):
            findings.append((str(rel), 'credential format'))
        for candidate in IP.findall(content):
            try:
                value = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if value.is_loopback or value.is_unspecified or candidate.startswith(('192.0.2.', '198.51.100.', '203.0.113.')):
                continue
            findings.append((str(rel), 'non-example network address'))
    for path, reason in findings:
        print(f'FAIL {path}: {reason}')
    print(f'Checked {len(selected)} release files; findings: {len(findings)}')
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())
