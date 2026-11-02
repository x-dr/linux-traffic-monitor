#!/usr/bin/env python3
"""Offline v2/v3 Agent maintenance. Preview by default; never stop services."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3

STREAMS = {
    'traffic': ('traffic_versions', 'minute_ts>=? AND minute_ts<?', 'interface,minute_ts'),
    'resources': ('resource_minutes', 'minute_ts>=? AND minute_ts<?', 'minute_ts'),
    'disk_io': ('disk_minutes', 'minute_ts>=? AND minute_ts<?', 'device,minute_ts'),
    'totals': ('total_versions', '1=1', 'interface'),
}


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('时间必须包含时区')
    result = int(parsed.timestamp())
    if result % 60:
        raise ValueError('时间范围须对齐整分钟')
    return result


def maintain(path, start, end, apply=False, stopped=False, backup=None, revision_floor=0):
    path = Path(path).resolve(strict=True)
    if end <= start or revision_floor < 0:
        raise ValueError('时间范围或 revision 下限无效')
    if apply and (not stopped or not backup):
        raise ValueError('正式执行必须提供 --agent-stopped 和独立的 --backup 路径')
    # This tool operates on the intact Agent DB after a CENTER rollback. Restoring
    # an older Agent DB also requires counter-baseline evidence and is unsupported.
    mode = 'rw' if apply else 'ro'
    db = sqlite3.connect(f'{path.as_uri()}?mode={mode}', uri=True, isolation_level=None)
    try:
        db.execute('PRAGMA busy_timeout=10000')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (2, 3):
            raise ValueError('仅支持已有的 v2/v3 Agent 数据库')
        streams = dict(STREAMS)
        if version == 3:
            streams['probes'] = ('probe_results', 'scheduled_at>=? AND scheduled_at<?', 'sample_id')
        source = db.execute("SELECT v FROM meta WHERE k='source_id'").fetchone()
        if not source or not source[0] or not db.execute("SELECT 1 FROM sqlite_master WHERE name='baselines'").fetchone():
            raise ValueError('不是有效 Agent 数据库')
        counts, high_water = {}, revision_floor
        high_water = max(high_water, int(db.execute("SELECT v FROM meta WHERE k='sequence'").fetchone()[0]))
        high_water = max(high_water, db.execute('SELECT COALESCE(MAX(cursor),0) FROM sync_state').fetchone()[0])
        for stream, (table, predicate, _) in streams.items():
            args = () if stream == 'totals' else (start, end)
            counts[stream] = db.execute(f'SELECT COUNT(*) FROM {table} WHERE {predicate}', args).fetchone()[0]
            high_water = max(high_water, db.execute(f'SELECT COALESCE(MAX(revision),0) FROM {table}').fetchone()[0])
        total = sum(counts.values())
        if high_water + total >= 2**63 - 1:
            raise ValueError('revision 已到达安全范围上限')
        result = {'from': datetime.fromtimestamp(start, timezone.utc).isoformat(),
                  'to': datetime.fromtimestamp(end, timezone.utc).isoformat(), 'rows': counts,
                  'high_water': high_water, 'next_sequence': high_water + total,
                  'source_id_preserved': True, 'counters_and_baselines_preserved': True, 'applied': False}
        if not apply:
            return result
        target = Path(backup).resolve()
        if target == path or target.exists():
            raise ValueError('备份目标必须是尚不存在的独立文件')
        # VACUUM INTO includes committed WAL contents. No raw main-file copy.
        previous_mask = os.umask(0o077)
        try:
            db.execute('VACUUM INTO ?', (str(target),))
        finally:
            os.umask(previous_mask)
        target.chmod(0o600)
        db.execute('BEGIN IMMEDIATE')
        try:
            current_sequence = int(db.execute("SELECT v FROM meta WHERE k='sequence'").fetchone()[0])
            if current_sequence > high_water:
                raise ValueError('Agent 仍在写入，请停止后重新预览')
            sequence = high_water
            for stream, (table, predicate, keys) in streams.items():
                args = () if stream == 'totals' else (start, end)
                rows = db.execute(f'SELECT {keys} FROM {table} WHERE {predicate} ORDER BY revision', args).fetchall()
                where = ' AND '.join(f'{column}=?' for column in keys.split(','))
                for row in rows:
                    sequence += 1
                    db.execute(f'UPDATE {table} SET revision=? WHERE {where}', (sequence, *row))
                    if stream == 'probes':
                        raw = db.execute('SELECT result FROM probe_results WHERE sample_id=?', row).fetchone()[0]
                        sample = json.loads(raw)
                        sample['revision'] = sequence
                        db.execute('UPDATE probe_results SET result=? WHERE sample_id=?', (json.dumps(sample, separators=(',', ':')), *row))
            db.execute("UPDATE meta SET v=? WHERE k='sequence'", (str(sequence),))
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        result['applied'] = True
        return result
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description='中心回退后，为指定时间范围的 Agent 记录分配新 revision；默认只读预览')
    parser.add_argument('--db', required=True)
    parser.add_argument('--from', dest='start', required=True)
    parser.add_argument('--to', dest='end', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--agent-stopped', action='store_true')
    parser.add_argument('--backup')
    parser.add_argument('--revision-floor', type=int, default=0, help='已知的中心或历史序列高水位，禁止使用更低 revision')
    args = parser.parse_args()
    try:
        result = maintain(args.db, timestamp(args.start), timestamp(args.end), args.apply, args.agent_stopped, args.backup, args.revision_floor)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, sqlite3.Error):
        parser.exit(1, '重新同步未完成：检查 v2/v3 Agent 库、停止确认、时间范围和独立备份路径；不支持恢复旧 Agent 库后直接上线。\n')


if __name__ == '__main__':
    main()
