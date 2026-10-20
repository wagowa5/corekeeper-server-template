#!/usr/bin/python3
"""Fetch the optional webhook at runtime, without exposing it to CloudFormation templates."""
import json
import os
import subprocess
from pathlib import Path

config = json.loads(Path('/etc/corekeeper/config.json').read_text())
env = {
    'WORLD_NAME': config['world_name'],
    'WORLD_INDEX': '0',
    'MAX_PLAYERS': str(config['max_players']),
    'PUID': '1000',
    'PGID': '1000',
}
if config['discord_parameter_arn']:
    result = subprocess.run(
        ['aws', 'ssm', 'get-parameter', '--name', config['discord_parameter_arn'],
         '--with-decryption', '--region', config['region'], '--output', 'json'],
        check=True, capture_output=True, text=True,
    )
    env['DISCORD_WEBHOOK_URL'] = json.loads(result.stdout)['Parameter']['Value']
if any('\n' in v or '\r' in v for v in env.values()):
    raise ValueError('Container environment values must be single-line')
# systemd RuntimeDirectory is root-only. Docker administrators can read container env.
path = Path('/run/corekeeper/container.env')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(''.join(f'{k}={v}\n' for k, v in env.items()))
subprocess.run(['docker', 'rm', '-f', 'core-keeper-dedicated'],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
os.execvp('docker', [
    'docker', 'run', '--name', 'core-keeper-dedicated', '--stop-timeout', '120',
    '--env-file', str(path), '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '-v', '/srv/corekeeper/server-data:/home/steam/core-keeper-data',
    '-v', '/srv/corekeeper/server-files:/home/steam/core-keeper-dedicated',
    config['image'],
])
