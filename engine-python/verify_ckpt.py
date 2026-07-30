# -*- coding: utf-8 -*-
"""下载后校验：用引擎真实加载路径验证 RealBasicVSR 主权重兼容性。

用法: python verify_ckpt.py <realbasicvsr_x4.pth> [spynet.pth]
打印 VERIFY_OK / VERIFY_FAIL 并以退出码表示结果。
"""
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ENGINE_DIR)


def main():
    if len(sys.argv) < 2:
        print('VERIFY_FAIL: 缺少参数')
        return 2
    ckpt = sys.argv[1]
    spynet = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != '-' else None
    try:
        import torch  # noqa: F401
        from vsr_models.realbasicvsr import load_realbasicvsr
        load_realbasicvsr(ckpt, spynet, device='cpu', fp16=False)
        print('VERIFY_OK')
        return 0
    except Exception as e:  # noqa: BLE001
        print(f'VERIFY_FAIL: {e}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
