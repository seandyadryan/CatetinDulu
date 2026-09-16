"""Append only our vhost to the existing Caddyfile; validate before reload."""
from pathlib import Path
import shutil, subprocess, datetime
p=Path('/home/ubuntu/AI-chat/Caddyfile')
original=p.read_text()
if 'catetindulu.amarlo.online {' not in original:
    shutil.copy2(p, str(p)+'.bak.catetindulu.'+datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
    block=Path('/home/ubuntu/CatetinDulu/deploy/Caddyfile.example').read_text()
    p.write_text(original+'\n'+block)
    try:
        subprocess.run(['docker','exec','ai-chat-caddy','caddy','validate','--config','/etc/caddy/Caddyfile'],check=True)
    except Exception:
        p.write_text(original)
        raise
subprocess.run(['docker','exec','ai-chat-caddy','caddy','reload','--config','/etc/caddy/Caddyfile'],check=True)
