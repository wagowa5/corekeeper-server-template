"""Exercise backup ordering and recovery using command doubles, without AWS/Docker."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BackupTests(unittest.TestCase):
    def run_backup(self, *, upload_fails=False, killed=False, leave=False, world=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'data/server-data/worlds').mkdir(parents=True)
            if world:
                (root / 'data/server-data/worlds/0.world.gzip').write_bytes(b'world-data')
            (root / 'config.json').write_text('{"bucket":"test-bucket","region":"ap-northeast-1"}')
            log = root / 'calls'
            log.touch()
            commands = {
                'mountpoint': 'exit 0',
                'systemctl': 'echo "systemctl $*" >> "$CALLS"; exit 0',
                'docker': '''if [[ "$*" == *ExitCode* ]]; then echo "$CONTAINER_EXIT"; else echo false; fi''',
                'aws': 'echo "aws $*" >> "$CALLS"; exit "$UPLOAD_EXIT"',
            }
            for name, body in commands.items():
                p = root / 'bin' / name
                p.write_text('#!/bin/bash\n' + body + '\n')
                p.chmod(0o700)
            script = (ROOT / 'infra/templates/backup.sh').read_text()
            script = script.replace('/run/corekeeper-backup.lock', str(root / 'lock'))
            script = script.replace('/srv/corekeeper', str(root / 'data'))
            script = script.replace('/etc/corekeeper/config.json', str(root / 'config.json'))
            script = script.replace('/var/tmp/corekeeper-', str(root / 'corekeeper-'))
            path = root / 'backup.sh'
            path.write_text(script)
            result = subprocess.run(['bash', str(path)] + (['--leave-stopped'] if leave else []),
                                    env={**os.environ, 'PATH': f"{root / 'bin'}:{os.environ['PATH']}",
                                         'CALLS': str(log), 'UPLOAD_EXIT': str(int(upload_fails)),
                                         'CONTAINER_EXIT': '137' if killed else '0'},
                                    capture_output=True, text=True)
            return result, log.read_text(), list(root.glob('corekeeper-*.tar.gz'))

    def test_success_restarts_server_and_removes_archive(self):
        result, calls, archives = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(calls.index('systemctl stop'), calls.index('aws s3 cp'))
        self.assertLess(calls.index('aws s3 cp'), calls.index('systemctl start'))
        self.assertEqual(archives, [])

    def test_stop_workflow_leaves_server_stopped_on_success(self):
        result, calls, _ = self.run_backup(leave=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('systemctl start', calls)

    def test_upload_failure_restarts_even_for_stop_workflow(self):
        result, calls, archives = self.run_backup(upload_fails=True, leave=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('systemctl start', calls)
        self.assertEqual(len(archives), 1)

    def test_force_killed_server_is_not_uploaded(self):
        result, calls, _ = self.run_backup(killed=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('aws s3 cp', calls)
        self.assertIn('systemctl start', calls)

    def test_missing_world_is_not_uploaded_or_stopped(self):
        result, calls, _ = self.run_backup(world=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
