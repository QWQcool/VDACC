"""对比 Python 版与 TS spike 的 probe 输出。

    python spike/ts-core/scripts/parity.py

只比较「契约字段」，不比较签名 URL / 缩略图签名 / 键序。
"""

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPIKE = ROOT / 'spike' / 'ts-core'
BUN = pathlib.Path.home() / 'AppData' / 'Local' / 'Temp' / 'vdacc-ts' / 'bun' / 'bun-windows-x64' / 'bun.exe'

CASES = [
    ('douyin', 'https://www.douyin.com/video/6961737553342991651'),
    ('netease', 'https://music.163.com/song?id=28606052'),
    ('bilibili', 'BV1j5nj68E48'),
]

FIELDS = ('id', 'label', 'width', 'height', 'ext', 'vcodec', 'acodec',
          'fps', 'bytes', 'bitrate', 'watermark', 'recommended')
MEDIA = ('id', 'title', 'author', 'duration_ms', 'platform')


def run(cmd, cwd):
    proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                          encoding='utf-8', errors='replace')
    if proc.returncode != 0 and not proc.stdout.strip():
        raise RuntimeError(f'{cmd} 失败: {proc.stderr[:400]}')
    return json.loads(proc.stdout)


def normalize(data):
    media = data.get('media') or {}
    formats = sorted(data.get('formats') or [], key=lambda f: f['id'])
    return {
        'ok': data.get('ok'),
        'platform': data.get('platform'),
        'media': {k: media.get(k) for k in MEDIA},
        'formats': [{k: f.get(k) for k in FIELDS} for f in formats],
    }


def diff(py, ts):
    out = []
    for key in ('ok', 'platform'):
        if py[key] != ts[key]:
            out.append(f'{key}: py={py[key]!r} ts={ts[key]!r}')
    for key in MEDIA:
        if py['media'].get(key) != ts['media'].get(key):
            out.append(f'media.{key}: py={py["media"].get(key)!r} ts={ts["media"].get(key)!r}')
    if len(py['formats']) != len(ts['formats']):
        out.append(f'formats 数量: py={len(py["formats"])} ts={len(ts["formats"])}')
    for a, b in zip(py['formats'], ts['formats']):
        for key in FIELDS:
            left, right = a.get(key), b.get(key)
            if left == right:
                continue
            # 体积是估算（码率 × 时长），允许 2% 误差；其它字段必须严格相等
            if key == 'bytes' and isinstance(left, int) and isinstance(right, int) and left:
                if abs(left - right) / left <= 0.02:
                    continue
            out.append(f'format[{a.get("id")}].{key}: py={left!r} ts={right!r}')
    return out


def main():
    failures = 0
    for name, url in CASES:
        print(f'=== {name} ===')
        try:
            py = normalize(run([sys.executable, '-m', 'vdl', 'probe', url, '--json'], ROOT))
            ts = normalize(run([str(BUN), 'src/cli.ts', 'probe', url, '--json'], SPIKE))
        except Exception as e:                       # noqa: BLE001
            print(f'  执行失败: {e}')
            failures += 1
            continue

        problems = diff(py, ts)
        if problems:
            failures += 1
            for line in problems:
                print(f'  ! {line}')
        else:
            print(f'  一致：{len(py["formats"])} 个档位，标题/作者/时长/体积全部相同')
    print('\n结论：', '全部一致' if not failures else f'{failures} 个用例存在差异')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
